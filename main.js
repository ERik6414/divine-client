// Divine Client – Hauptprozess (Electron)
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const AdmZip = require('adm-zip');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const UA = { 'User-Agent': 'DivineClient/4.0 (warden-client-for-mc)' };
const API = 'https://api.modrinth.com/v2', MS = 'https://api.minecraftservices.com';
const enc = a => encodeURIComponent(JSON.stringify(a));
const ud = n => path.join(app.getPath('userData'), n);
const asset = (...a) => path.join(__dirname, 'assets', ...a);
const root = () => ud('minecraft');
const safe = n => n.replace(/[^\w\- ]/g, '_');
const packFile = n => path.join(ud('packs'), safe(n) + '.json');
const gameDir = n => path.join(ud('instances'), safe(n));
const loadPack = n => JSON.parse(fs.readFileSync(packFile(n), 'utf8'));
const savePack = p => { fs.mkdirSync(ud('packs'), { recursive: true }); fs.writeFileSync(packFile(p.name), JSON.stringify(p, null, 2)); };

// ---------- Einstellungen ----------
const DEF = {
  ram: 4, jvm: '', servers: [], minimize: false, hideName: false, ghToken: '', serverCfg: {}, customCheats: [],
  divine: { menu: true, bg: '', gui: '', fov: '', renderDistance: '', maxFps: '', fullbright: '', outline: '' }
};
const getSet = () => {
  let s = {}; try { if (fs.existsSync(ud('settings.json'))) s = JSON.parse(fs.readFileSync(ud('settings.json'), 'utf8')); } catch {}
  return { ...DEF, ...s, divine: { ...DEF.divine, ...(s.divine || {}) } };
};
const putSet = n => { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(ud('settings.json'), JSON.stringify(n, null, 2)); return n; };

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
let win, session = null;

const j = async (u, h) => { const r = await fetch(u, { headers: { ...UA, ...(h || {}) } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const log = m => win && win.webContents.send('log', m);
const prog = (pct, text) => log({ pct, text });
const tok = () => session.mclc().access_token;

// ---------- Minecraft-Versionen (alle, bis 26.2 und neuer – direkt von Mojang) ----------
const FALLBACK_VERSIONS = ['26.2', '26.1.2', '26.1.1', '26.1', '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21', '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20', '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19', '1.18.2', '1.18.1', '1.18', '1.17.1', '1.17', '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16', '1.15.2', '1.14.4', '1.13.2', '1.12.2', '1.8.9'];
let MAN = null;
async function manifest() {
  if (MAN && Date.now() - MAN.t < 36e5) return MAN.d;
  try { const d = await j('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'); MAN = { t: Date.now(), d }; return d; }
  catch (e) { if (MAN) return MAN.d; throw e; }
}
ipcMain.handle('versions:list', async () => {
  try { const m = await manifest(); return { releases: m.versions.filter(v => v.type === 'release').map(v => v.id), snapshots: m.versions.filter(v => v.type === 'snapshot').slice(0, 15).map(v => v.id) }; }
  catch { return { releases: FALLBACK_VERSIONS, snapshots: [] }; }
});
const parseV = mc => String(mc).split(/[.\-]/).map(n => parseInt(n)).map(n => isNaN(n) ? 0 : n);
function javaGuess(mc) {
  const [a, b, c] = parseV(mc);
  if (a >= 26) return 25;
  if (a === 1) { if (b <= 16) return 8; if (b < 20 || (b === 20 && (c || 0) < 5)) return 17; return 21; }
  return 25;
}
async function javaFor(mc) { // Java-Version laut Mojang (z. B. 25 für 26.x)
  try {
    const e = (await manifest()).versions.find(v => v.id === mc);
    if (e) { const v = await j(e.url); if (v.javaVersion && v.javaVersion.majorVersion) return Math.max(8, v.javaVersion.majorVersion === 16 ? 17 : v.javaVersion.majorVersion); }
  } catch {}
  return javaGuess(mc);
}
async function download(url, dest) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Download fehlgeschlagen (${r.status})`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}
async function ensureJava(major) {
  if (process.platform !== 'win32') return null;
  const dir = ud('java/' + major);
  const find = () => fs.existsSync(dir) ? fs.readdirSync(dir).map(d => path.join(dir, d, 'bin')).find(b => fs.existsSync(path.join(b, 'javaw.exe'))) : null;
  let b = find(); if (b) return b;
  prog(1, `Lade Java ${major} (einmalig) …`);
  const r = await fetch(`https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`, { headers: UA });
  if (!r.ok) throw new Error('Java-Download fehlgeschlagen (' + r.status + ')');
  new AdmZip(Buffer.from(await r.arrayBuffer())).extractAllTo(dir, true);
  b = find(); if (!b) throw new Error('Java konnte nicht entpackt werden.');
  return b;
}

// ---------- Mods / Loader ----------
async function resolveMod(pack, slug, title, seen = new Set()) {
  if (pack.loader === 'vanilla') throw new Error('Vanilla-Profile haben keinen Mod-Loader – wähle Fabric, Quilt, Forge oder NeoForge.');
  const vs = await j(`${API}/project/${slug}/version?game_versions=${enc([pack.mc])}&loaders=${enc(pack.loader === 'quilt' ? ['quilt', 'fabric'] : [pack.loader || 'fabric'])}`);
  const v = vs[0];
  if (!v) throw new Error(`Keine Version von "${title || slug}" für ${pack.mc}`);
  if (seen.has(v.project_id)) return;
  seen.add(v.project_id);
  if (!pack.mods.some(m => m.id === v.project_id)) {
    const f = v.files.find(x => x.primary) || v.files[0];
    pack.mods.push({ id: v.project_id, title: title || v.name, filename: f.filename, url: f.url });
  }
  for (const d of v.dependencies) if (d.dependency_type === 'required' && d.project_id) await resolveMod(pack, d.project_id, null, seen);
}
function runInstaller(javaBin, jar) {
  fs.mkdirSync(root(), { recursive: true });
  const lp = path.join(root(), 'launcher_profiles.json');
  if (!fs.existsSync(lp)) fs.writeFileSync(lp, '{"profiles":{}}');
  return new Promise((res, rej) => {
    const c = require('child_process').spawn(javaBin ? path.join(javaBin, 'java.exe') : 'java', ['-jar', jar, '--installClient', root()], { windowsHide: true });
    c.stdout.on('data', d => log(String(d).trim())); c.stderr.on('data', d => log(String(d).trim()));
    c.on('error', e => rej(new Error('Java nicht gefunden: ' + e.message)));
    c.on('close', code => code === 0 ? res() : rej(new Error('Loader-Installer fehlgeschlagen (Code ' + code + ')')));
  });
}
async function installLoader(mc, loader = 'fabric', ver, javaBin) {
  if (loader === 'vanilla') return undefined;
  if (loader === 'fabric' || loader === 'quilt') {
    const base = loader === 'quilt' ? 'https://meta.quiltmc.org/v3' : 'https://meta.fabricmc.net/v2';
    let list; try { list = await j(`${base}/versions/loader/${mc}`); } catch { list = []; }
    if (!list.length) throw new Error(`${loader === 'quilt' ? 'Quilt' : 'Fabric'} unterstützt ${mc} (noch) nicht.`);
    if (!ver) ver = list[0].loader.version;
    const id = `${loader}-loader-${ver}-${mc}`;
    const dest = path.join(root(), 'versions', id, `${id}.json`);
    if (!fs.existsSync(dest)) await download(`${base}/versions/loader/${mc}/${ver}/profile/json`, dest);
    return id;
  }
  let url, id;
  if (loader === 'forge') {
    if (!ver) { const pr = (await j('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos; ver = pr[`${mc}-recommended`] || pr[`${mc}-latest`]; if (!ver) throw new Error(`Kein Forge für ${mc} gefunden.`); }
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${ver}/forge-${mc}-${ver}-installer.jar`; id = `${mc}-forge-${ver}`;
  } else if (loader === 'neoforge') {
    if (mc === '1.20.1') throw new Error('NeoForge für 1.20.1 wird nicht unterstützt – nimm Forge.');
    if (!ver) { const [, a, b] = mc.split('.'), pre = `${a}.${b || 0}.`; const vs = (await j('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions.filter(v => v.startsWith(pre)); const st = vs.filter(v => !/beta|alpha/.test(v)); ver = (st.length ? st : vs).pop(); if (!ver) throw new Error(`Kein NeoForge für ${mc} gefunden.`); }
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`; id = `neoforge-${ver}`;
  } else throw new Error('Unbekannter Loader: ' + loader);
  if (!fs.existsSync(path.join(root(), 'versions', id, id + '.json'))) {
    const jar = ud(`installers/${id}.jar`);
    prog(5, `Installiere ${loader} (kann einige Minuten dauern) …`);
    if (!fs.existsSync(jar)) await download(url, jar);
    await runInstaller(javaBin, jar);
  }
  return id;
}
async function setSession(xbox) {
  session = await xbox.getMinecraft();
  try { fs.writeFileSync(ud('auth.json'), xbox.save()); } catch (e) { log('Anmeldung konnte nicht gespeichert werden: ' + e.message); }
  return { name: session.profile.name, id: session.profile.id };
}

// ---------- Fenster ----------
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1040, minHeight: 680, frame: false, title: 'Divine Client',
    icon: asset('icon.png'),
    transparent: process.platform !== 'linux', backgroundColor: '#00000000',
    vibrancy: 'under-window', backgroundMaterial: 'acrylic',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile('index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});
app.on('window-all-closed', () => app.quit());
ipcMain.on('win', (_, a) => { if (a === 'min') win.minimize(); if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize(); if (a === 'close') win.close(); });

ipcMain.handle('settings:get', getSet);
ipcMain.handle('settings:set', (_, s) => { const cur = getSet(), n = { ...cur, ...s }; if (s.divine) n.divine = { ...cur.divine, ...s.divine }; return putSet(n); });
ipcMain.handle('open:folder', (_, n) => { fs.mkdirSync(gameDir(n), { recursive: true }); return shell.openPath(gameDir(n)); });

// ---------- Anmeldung / Skins ----------
ipcMain.handle('login', async () => setSession(await new Auth('select_account').launch('electron')));
ipcMain.handle('autologin', async () => { try { if (!fs.existsSync(ud('auth.json'))) return null; return await setSession(await new Auth('select_account').refresh(fs.readFileSync(ud('auth.json'), 'utf8'))); } catch (e) { log('Automatische Anmeldung fehlgeschlagen: ' + e.message); return null; } });
ipcMain.handle('logout', () => { session = null; fs.rmSync(ud('auth.json'), { force: true }); });

ipcMain.handle('skins:list', async () => {
  fs.mkdirSync(ud('skins'), { recursive: true });
  let current = null;
  if (session) try {
    const p = await (await fetch(MS + '/minecraft/profile', { headers: { Authorization: 'Bearer ' + tok() } })).json();
    const s = (p.skins || []).find(x => x.state === 'ACTIVE');
    if (s) current = { url: 'data:image/png;base64,' + Buffer.from(await (await fetch(s.url)).arrayBuffer()).toString('base64'), variant: s.variant };
  } catch {}
  const library = fs.readdirSync(ud('skins')).filter(f => f.endsWith('.png')).map(f => ({ name: f, data: 'data:image/png;base64,' + fs.readFileSync(path.join(ud('skins'), f)).toString('base64') }));
  return { current, library };
});
ipcMain.handle('skins:import', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Skin (PNG)', extensions: ['png'] }], properties: ['openFile', 'multiSelections'] });
  fs.mkdirSync(ud('skins'), { recursive: true });
  for (const f of r.filePaths) fs.copyFileSync(f, path.join(ud('skins'), path.basename(f)));
});
ipcMain.handle('skins:save', (_, { name, data }) => { fs.mkdirSync(ud('skins'), { recursive: true }); const f = safe(String(name || 'Pixler-Skin').slice(0, 40)) + '.png'; fs.writeFileSync(path.join(ud('skins'), f), Buffer.from(String(data).split(',')[1], 'base64')); return f; });
ipcMain.handle('skins:delete', (_, n) => fs.rmSync(path.join(ud('skins'), path.basename(n)), { force: true }));
ipcMain.handle('skins:apply', async (_, { name, variant }) => {
  if (!session) throw new Error('Bitte zuerst anmelden.');
  const fd = new FormData();
  fd.append('variant', variant);
  fd.append('file', new Blob([fs.readFileSync(path.join(ud('skins'), path.basename(name)))], { type: 'image/png' }), 'skin.png');
  const r = await fetch(MS + '/minecraft/profile/skins', { method: 'POST', headers: { Authorization: 'Bearer ' + tok() }, body: fd });
  if (!r.ok) throw new Error('Skin konnte nicht gesetzt werden: ' + r.status);
});

// ---------- Modrinth ----------
ipcMain.handle('search', async (_, { q, type, mc, loader, cat, index, offset }) => {
  const facets = [[`project_type:${type}`], loader ? [`categories:${loader}`] : ['categories:fabric', 'categories:quilt', 'categories:forge', 'categories:neoforge']];
  if (mc) facets.push([`versions:${mc}`]);
  if (cat) facets.push([`categories:${cat}`]);
  const r = await j(`${API}/search?query=${encodeURIComponent(q || '')}&facets=${enc(facets)}&limit=20&offset=${offset || 0}&index=${index || 'relevance'}`);
  return { total: r.total_hits, hits: r.hits.map(h => ({ slug: h.slug, title: h.title, desc: h.description, icon: h.icon_url, downloads: h.downloads, follows: h.follows, author: h.author, cats: (h.display_categories || h.categories || []).slice(0, 4) })) };
});
// Detailseite wie bei Modrinth
ipcMain.handle('project:get', async (_, slug) => {
  const [p, vs] = await Promise.all([j(`${API}/project/${slug}`), j(`${API}/project/${slug}/version`).catch(() => [])]);
  return {
    slug: p.slug, title: p.title, desc: p.description, body: p.body || '', icon: p.icon_url, downloads: p.downloads, follows: p.followers, type: p.project_type,
    cats: (p.categories || []).slice(0, 8), loaders: p.loaders || [], gv: (p.game_versions || []).slice(-14).reverse(),
    gallery: (p.gallery || []).slice(0, 6).map(g => ({ url: g.url, title: g.title })),
    links: { src: p.source_url, issues: p.issues_url, wiki: p.wiki_url, discord: p.discord_url },
    versions: vs.slice(0, 10).map(v => ({ name: v.name, num: v.version_number, gv: v.game_versions.slice(-4), loaders: v.loaders, date: v.date_published, type: v.version_type, dl: v.downloads }))
  };
});
ipcMain.handle('pack:install', async (_, { slug, title, icon, loader: want, mc: wantMc }) => {
  const vs = await j(`${API}/project/${slug}/version?loaders=${enc(want ? [want] : ['fabric', 'quilt', 'forge', 'neoforge'])}`);
  const v = vs.find(x => !wantMc || x.game_versions.includes(wantMc)) || vs[0];
  if (!v) throw new Error('Keine passende Modpack-Version gefunden.');
  const f = v.files.find(x => x.primary) || v.files[0];
  prog(2, `Lade ${title} …`);
  const zip = new AdmZip(Buffer.from(await (await fetch(f.url, { headers: UA })).arrayBuffer()));
  const idx = JSON.parse(zip.readAsText('modrinth.index.json')), dep = idx.dependencies;
  const loader = dep['fabric-loader'] ? 'fabric' : dep['quilt-loader'] ? 'quilt' : dep.neoforge ? 'neoforge' : dep.forge ? 'forge' : null;
  if (!loader) throw new Error('Unbekannter Mod-Loader in diesem Modpack.');
  let name = title, n = 2;
  while (fs.existsSync(packFile(name))) name = `${title} ${n++}`;
  const game = path.resolve(gameDir(name));
  const list = idx.files.filter(x => !x.env || x.env.client !== 'unsupported'), q = [...list];
  let done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let x; (x = q.shift());) {
      const dest = path.resolve(game, x.path);
      if (!dest.startsWith(game + path.sep)) continue;
      await download(x.downloads[0], dest);
      prog(5 + 90 * (++done) / list.length, `Lade ${path.basename(x.path)} (${done}/${list.length})`);
    }
  }));
  for (const e of zip.getEntries()) for (const pre of ['overrides/', 'client-overrides/'])
    if (e.entryName.startsWith(pre) && !e.isDirectory) {
      const dest = path.resolve(game, e.entryName.slice(pre.length));
      if (dest.startsWith(game + path.sep)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, e.getData()); }
    }
  savePack({ name, mc: dep.minecraft, loader, loaderVersion: dep[loader === 'fabric' || loader === 'quilt' ? loader + '-loader' : loader], mods: [], managed: true, icon, slug, count: list.length, last: 0 });
  prog(100, 'Fertig');
  return name;
});

// ---------- Profile ----------
ipcMain.handle('packs:list', () => fs.existsSync(ud('packs')) ? fs.readdirSync(ud('packs')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(ud('packs'), f), 'utf8'))) : []);
ipcMain.handle('packs:create', (_, p) => fs.existsSync(packFile(p.name)) ? null : savePack({ name: p.name, mc: p.mc, loader: p.loader || 'fabric', mods: [], last: 0 }));
ipcMain.handle('packs:delete', (_, n) => { fs.rmSync(packFile(n), { force: true }); fs.rmSync(gameDir(n), { recursive: true, force: true }); });
ipcMain.handle('packs:add', async (_, { pack, slug, title }) => { const p = loadPack(pack); await resolveMod(p, slug, title); savePack(p); });
ipcMain.handle('packs:remove', (_, { pack, id }) => { const p = loadPack(pack); p.mods = p.mods.filter(m => m.id !== id); savePack(p); });
ipcMain.handle('packs:dup', (_, n) => { const p = loadPack(n); let nn = `${n} Kopie`, k = 2; while (fs.existsSync(packFile(nn))) nn = `${n} Kopie ${k++}`; if (fs.existsSync(gameDir(n))) fs.cpSync(gameDir(n), gameDir(nn), { recursive: true }); savePack({ ...p, name: nn, last: 0, played: 0 }); return nn; });
ipcMain.handle('packs:export', (_, n) => JSON.stringify(loadPack(n), null, 2));
ipcMain.handle('packs:rename', (_, { from, to }) => {
  to = String(to || '').trim(); if (!to) throw new Error('Gib einen Namen an.');
  if (to === from) return to;
  if (fs.existsSync(packFile(to))) throw new Error('Diesen Namen gibt es schon.');
  const p = loadPack(from); p.name = to;
  if (fs.existsSync(gameDir(from))) fs.renameSync(gameDir(from), gameDir(to));
  savePack(p); fs.rmSync(packFile(from), { force: true }); return to;
});
ipcMain.handle('packs:setIcon', async (_, n) => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Bild', extensions: ['png', 'jpg', 'jpeg'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('Bild konnte nicht gelesen werden.');
  const sz = img.getSize(), m = Math.min(sz.width, sz.height);
  const sq = img.crop({ x: (sz.width - m) >> 1, y: (sz.height - m) >> 1, width: m, height: m }).resize({ width: 128, height: 128, quality: 'best' });
  const p = loadPack(n); p.icon = 'data:image/png;base64,' + sq.toPNG().toString('base64'); savePack(p); return p.icon;
});
ipcMain.handle('packs:files', (_, n) => {
  const dir = path.join(gameDir(n), 'mods');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.jar(\.disabled)?$/i.test(f)).sort().map(f => ({ file: f, off: f.endsWith('.disabled'), size: fs.statSync(path.join(dir, f)).size })) : [];
});
ipcMain.handle('packs:toggle', (_, { pack, file }) => {
  if (!loadPack(pack).managed) throw new Error('Nur bei installierten Modpacks möglich.');
  const dir = path.join(gameDir(pack), 'mods'), from = path.join(dir, path.basename(file));
  fs.renameSync(from, file.endsWith('.disabled') ? from.slice(0, -9) : from + '.disabled');
});
ipcMain.handle('mods:importJar', async (_, pack) => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Mod (JAR)', extensions: ['jar'] }], properties: ['openFile', 'multiSelections'] });
  const p = loadPack(pack), dir = path.join(gameDir(pack), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of r.filePaths) { const n = path.basename(f); fs.copyFileSync(f, path.join(dir, n)); if (!p.mods.some(m => m.filename === n)) p.mods.push({ id: 'local:' + n, title: n.replace(/\.jar$/i, ''), filename: n }); }
  savePack(p); return r.filePaths.length;
});

// ---------- Divine: Resourcepack (Hauptmenü, Logo, Hintergrund) ----------
const PACK_V = 5;
function rpFormat(mc) { // Resourcepack-Format je Minecraft-Version (26.1 → 84, 26.2 → 88)
  const [a, b, c] = parseV(mc);
  if (a >= 26) return a === 26 && b === 1 ? 84 : 88;
  if (a !== 1) return 88;
  const t = [[21, 11, 75], [21, 9, 69], [21, 7, 64], [21, 6, 63], [21, 5, 55], [21, 4, 46], [21, 2, 42], [21, 0, 34], [20, 5, 32], [20, 3, 22], [20, 2, 18], [20, 0, 15], [19, 4, 13], [19, 3, 12], [19, 0, 9], [18, 0, 8], [17, 0, 7], [16, 2, 6], [15, 0, 5], [13, 0, 4], [11, 0, 3], [9, 0, 2]];
  for (const [mi, pa, f] of t) if (b > mi || (b === mi && (c || 0) >= pa)) return f;
  return 1;
}
const mcmeta = fmt => {
  const description = '§6Divine Client §7· §eby ErikFCH1965';
  return { pack: fmt >= 65 ? { description, min_format: fmt, max_format: 999 } : { description, pack_format: fmt } };
};
function panoramaFaces(file) { // ein Bild → 6 Panorama-Seiten (gespiegelt, damit die Kanten nahtlos sind)
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error('Hintergrundbild konnte nicht gelesen werden.');
  const sz = img.getSize(), m = Math.min(sz.width, sz.height), S = 1024;
  img = img.crop({ x: (sz.width - m) >> 1, y: (sz.height - m) >> 1, width: m, height: m }).resize({ width: S, height: S, quality: 'best' });
  const bmp = img.toBitmap(), flip = Buffer.alloc(bmp.length);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const s = (y * S + (S - 1 - x)) * 4; bmp.copy(flip, (y * S + x) * 4, s, s + 4); }
  const solid = row => { const o = (row * S + (S >> 1)) * 4, b = Buffer.alloc(S * S * 4); b.fill(bmp.subarray(o, o + 4)); return b; };
  const png = b => nativeImage.createFromBitmap(b, { width: S, height: S }).toPNG();
  const a = png(bmp), f = png(flip);
  return [a, f, a, f, png(solid(2)), png(solid(S - 3))];
}
function optRead(game) { const f = path.join(game, 'options.txt'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; }
const optGet = (t, k) => { const m = t.match(new RegExp('^' + k + ':(.*)$', 'm')); return m ? m[1].trim() : null; };
const optSet = (t, k, v) => { const re = new RegExp('^' + k + ':.*$', 'm'); return re.test(t) ? t.replace(re, `${k}:${v}`) : t + (t && !/\n$/.test(t) ? '\n' : '') + `${k}:${v}\n`; };
const listSet = (t, k, fn) => { let a = []; try { a = JSON.parse(optGet(t, k) || '[]'); } catch {} return optSet(t, k, JSON.stringify(fn(a))); };

function buildDivine(game, mc, s) {
  const on = !!s.divine.menu;
  let t = optRead(game);
  const dir = path.join(game, 'resourcepacks', 'Divine');
  if (!on) {
    t = listSet(t, 'resourcePacks', a => a.filter(x => x !== 'file/Divine'));
    fs.mkdirSync(game, { recursive: true }); fs.writeFileSync(path.join(game, 'options.txt'), t); return;
  }
  const fmt = rpFormat(mc), custom = s.divine.bg && fs.existsSync(s.divine.bg) ? s.divine.bg : '';
  const stamp = JSON.stringify({ PACK_V, fmt, custom, cm: custom ? fs.statSync(custom).mtimeMs : 0 });
  const mark = path.join(dir, '.divine');
  if (!fs.existsSync(mark) || fs.readFileSync(mark, 'utf8') !== stamp) {
    fs.rmSync(dir, { recursive: true, force: true });
    const w = (rel, data) => { const f = path.join(dir, 'assets/minecraft', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.mcmeta'), JSON.stringify(mcmeta(fmt), null, 2));
    fs.copyFileSync(asset('pack.png'), path.join(dir, 'pack.png'));
    if (fmt >= 12) { w('textures/gui/title/minecraft.png', fs.readFileSync(asset('title.png'))); w('textures/gui/title/edition.png', fs.readFileSync(asset('edition.png'))); }
    const faces = custom ? panoramaFaces(custom) : [0, 1, 2, 3, 4, 5].map(i => fs.readFileSync(asset('panorama', `panorama_${i}.png`)));
    faces.forEach((b, i) => w(`textures/gui/title/background/panorama_${i}.png`, b));
    if (fmt >= 18) {
      const meta = JSON.stringify({ gui: { scaling: { type: 'nine_slice', width: 200, height: 20, border: 3 } } });
      for (const n of ['button', 'button_highlighted', 'button_disabled']) { w(`textures/gui/sprites/widget/${n}.png`, fs.readFileSync(asset(n + '.png'))); w(`textures/gui/sprites/widget/${n}.png.mcmeta`, meta); }
      w('textures/gui/menu_background.png', fs.readFileSync(asset('menu_background.png')));
      w('textures/gui/inworld_menu_background.png', fs.readFileSync(asset('menu_background.png')));
    }
    w('texts/splashes.txt', ['Divine Client!', 'Made by ErikFCH1965!', 'Hell wie die Sonne!', 'Feuer und Gold!', 'Mehr FPS, mehr Spaß!', 'Powered by Divine!', 'Willkommen zurück!', 'Zeit zu spielen!'].join('\n') + '\n');
    const lang = JSON.stringify({ 'title.credits': 'Divine Client by ErikFCH1965 – Minecraft © Mojang AB', 'menu.modded': ' (Divine)' });
    w('lang/en_us.json', lang); w('lang/de_de.json', lang);
    fs.writeFileSync(mark, stamp);
  }
  const add = a => a.includes('file/Divine') ? a : [...a, 'file/Divine'];
  t = listSet(t, 'resourcePacks', a => add(a.length ? a : ['vanilla']));
  t = listSet(t, 'incompatibleResourcePacks', add);
  t = optSet(t, 'monochromeLogo', 'true'); t = optSet(t, 'darkMojangStudiosBackground', 'true');
  fs.mkdirSync(game, { recursive: true }); fs.writeFileSync(path.join(game, 'options.txt'), t);
}

// Ladebildschirm: Der „Mojang Studios“-Schriftzug wird aus der Vanilla-Jar geladen (nicht aus Ressourcenpaketen) –
// deshalb tauschen wir ihn direkt in der Client-Jar aus (plus Fenster-Icons).
const PATCH_V = 'p3';
function patchClientJar(game, ids, s) {
  if (!s.divine.menu) return;
  const logo = fs.readFileSync(asset('loading_logo.png'));
  const stamp = PATCH_V + ':' + crypto.createHash('md5').update(logo).digest('hex').slice(0, 10);
  for (const id of new Set(ids.filter(Boolean))) {
    const jar = path.join(root(), 'versions', id, id + '.jar');
    if (!fs.existsSync(jar)) continue;
    try {
      const z = new AdmZip(jar), mk = z.getEntry('divine.patched');
      if (mk && mk.getData().toString() === stamp) continue;
      let n = 0;
      for (const e of z.getEntries()) {
        let src = null; const nm = e.entryName;
        if (/(^|\/)textures\/gui\/title\/mojangstudios\.png$/.test(nm)) src = 'loading_logo.png';
        else { const m = nm.match(/^assets\/icons\/icon_(\d+)x\1\.png$/); if (m && fs.existsSync(asset(`icon_${m[1]}x${m[1]}.png`))) src = `icon_${m[1]}x${m[1]}.png`; }
        if (src) { z.updateFile(e, fs.readFileSync(asset(src))); n++; }
      }
      if (mk) z.updateFile(mk, Buffer.from(stamp)); else z.addFile('divine.patched', Buffer.from(stamp));
      const tmp = jar + '.divine';
      z.writeZip(tmp); fs.renameSync(tmp, jar);
      fs.rmSync(path.join(game, '.fabric', 'remappedJars'), { recursive: true, force: true }); // Fabric baut die Jar neu
      log(`Divine: Ladebildschirm/Logo in ${id} ersetzt (${n} Dateien).`);
    } catch (e) { log('Divine: Jar konnte nicht angepasst werden: ' + e.message); }
  }
}

// ---------- Divine Settings → options.txt (GUI-Größe pro Server, FOV, …) ----------
function applyOptions(game, s, server) {
  const d = s.divine, sc = (server && s.serverCfg[server]) || {}, f = path.join(game, 'options.txt');
  let t = optRead(game);
  const gui = sc.gui !== undefined && sc.gui !== '' ? String(sc.gui) : d.gui;
  const cur = getSet(); let changed = false;
  if (gui !== '' && gui != null) {
    if (cur.guiBackup === undefined && sc.gui !== undefined && sc.gui !== '') { cur.guiBackup = optGet(t, 'guiScale') || '0'; changed = true; }
    t = optSet(t, 'guiScale', gui);
  } else if (cur.guiBackup !== undefined) { t = optSet(t, 'guiScale', cur.guiBackup); delete cur.guiBackup; changed = true; }
  if (changed) putSet(cur);
  if (d.fov !== '') t = optSet(t, 'fov', ((Math.max(30, Math.min(110, +d.fov)) - 70) / 40).toFixed(4));
  if (d.renderDistance !== '') t = optSet(t, 'renderDistance', Math.max(2, Math.min(64, +d.renderDistance)));
  if (d.maxFps !== '') t = optSet(t, 'maxFps', Math.max(10, Math.min(260, +d.maxFps)));
  if (d.fullbright === 'on') t = optSet(t, 'gamma', '1.0'); else if (d.fullbright === 'off') t = optSet(t, 'gamma', '0.5');
  if (d.outline === 'on') t = optSet(t, 'highContrastBlockOutline', 'true'); else if (d.outline === 'off') t = optSet(t, 'highContrastBlockOutline', 'false');
  fs.mkdirSync(game, { recursive: true }); fs.writeFileSync(f, t);
}
ipcMain.handle('divine:pickBg', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Bild', extensions: ['png', 'jpg', 'jpeg'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return getSet();
  if (nativeImage.createFromPath(r.filePaths[0]).isEmpty()) throw new Error('Bild konnte nicht gelesen werden.');
  fs.mkdirSync(ud('divine'), { recursive: true });
  const dest = ud('divine/background' + path.extname(r.filePaths[0]).toLowerCase());
  fs.copyFileSync(r.filePaths[0], dest);
  const cur = getSet(); return putSet({ ...cur, divine: { ...cur.divine, bg: dest } });
});
ipcMain.handle('divine:resetBg', () => { const cur = getSet(); return putSet({ ...cur, divine: { ...cur.divine, bg: '' } }); });
ipcMain.handle('divine:bgPreview', () => {
  const s = getSet(), f = s.divine.bg && fs.existsSync(s.divine.bg) ? s.divine.bg : asset('bg.png');
  const img = nativeImage.createFromPath(f); if (img.isEmpty()) return '';
  return 'data:image/jpeg;base64,' + img.resize({ width: 480, quality: 'good' }).toJPEG(80).toString('base64');
});

// ---------- Spielstart ----------
const qpArgs = (mc, addr) => {
  if (!addr) return [];
  const [a, b] = parseV(mc);
  if (a >= 26 || (a === 1 && b >= 20)) return ['--quickPlayMultiplayer', addr];
  const [h, p] = addr.split(':'); return ['--server', h, ...(p ? ['--port', p] : [])];
};
let proc = null, busy = false;
ipcMain.handle('stop', () => { if (proc) proc.kill(); });
ipcMain.handle('play', async (_, { pack, server }) => {
  if (!session) throw new Error('Bitte zuerst anmelden.');
  if (busy || proc) throw new Error('Es läuft bereits ein Spiel.');
  busy = true; log({ state: 'starting', pack });
  try {
    const s = getSet(), p = loadPack(pack), game = gameDir(p.name), modsDir = path.join(game, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    const javaBin = await ensureJava(await javaFor(p.mc));
    const dmj = asset('divine-mod.jar'); // Divine-Mod braucht Fabric API – automatisch ergänzen
    if (fs.existsSync(dmj) && p.mc === '1.21.1' && ['fabric', 'quilt'].includes(p.loader || 'fabric') && !p.mods.some(m => /fabric.?api/i.test(m.title)) && !fs.readdirSync(modsDir).some(f => /fabric-api/i.test(f))) { try { await resolveMod(p, 'fabric-api', 'Fabric API'); savePack(p); } catch (e) { log('Fabric API konnte nicht ergänzt werden: ' + e.message); } }
    if (!p.managed) for (const f of fs.readdirSync(modsDir)) if (!p.mods.some(m => m.filename === f)) fs.rmSync(path.join(modsDir, f));
    for (const m of p.mods) { const d = path.join(modsDir, m.filename); if (m.url && !fs.existsSync(d)) { log(`Lade ${m.title} …`); await download(m.url, d); } }
    try { const dm = asset('divine-mod.jar'); if (fs.existsSync(dm) && p.mc === '1.21.1' && ['fabric', 'quilt'].includes(p.loader || 'fabric')) fs.copyFileSync(dm, path.join(modsDir, 'divine-mod.jar')); } catch {}
    const custom = await installLoader(p.mc, p.loader, p.loaderVersion, javaBin);
    p.last = Date.now(); savePack(p);
    try { buildDivine(game, p.mc, s); } catch (e) { log('Divine-Menü konnte nicht erstellt werden: ' + e.message); }
    try { applyOptions(game, s, server); } catch (e) { log('Optionen konnten nicht gesetzt werden: ' + e.message); }
    patchClientJar(game, [custom, p.mc], s);
    const c = new Client();
    c.on('debug', log); c.on('data', log);
    c.on('arguments', () => patchClientJar(game, [custom, p.mc], s)); // direkt vor dem Start (falls die Jar gerade erst geladen wurde)
    c.on('progress', e => prog(Math.round(100 * e.task / Math.max(1, e.total)), `${e.type}: ${e.task}/${e.total}`));
    const t0 = Date.now();
    c.on('close', code => { proc = null; try { const q = loadPack(pack); q.played = (q.played || 0) + Date.now() - t0; savePack(q); } catch {} log({ state: 'idle', code }); if (getSet().minimize && win) win.restore(); });
    proc = await c.launch({
      authorization: session.mclc(), root: root(),
      javaPath: javaBin ? path.join(javaBin, 'javaw.exe') : 'java',
      version: { number: p.mc, type: 'Divine Client', custom },
      memory: { max: `${s.ram}G`, min: '2G' },
      customArgs: ['-Dminecraft.launcher.brand=Divine', '-Dminecraft.launcher.version=6.0', ...s.jvm.split(' ').filter(Boolean)],
      customLaunchArgs: qpArgs(p.mc, server),
      overrides: { gameDirectory: game }
    });
    if (!proc) throw new Error('Minecraft konnte nicht gestartet werden – siehe Log.');
    log({ state: 'running', pack });
    if (s.minimize) win.minimize();
  } catch (e) { proc = null; log({ state: 'idle' }); throw e; }
  finally { busy = false; }
});

// ---------- Cheat-Ecke ----------
const CHEATS = [
  { id: 'meteor', name: 'Meteor Client', repo: 'MeteorDevelopment/meteor-client', api: 'https://meteorclient.com/api/download?version={mc}', site: 'https://meteorclient.com', cat: 'Utility-Client', c: ['#8b5cf6', '#4c1d95'], desc: 'Beliebter Open-Source-Client mit vielen Modulen, GUI und Addons.' },
  { id: 'wurst', name: 'Wurst Client', repo: 'Wurst-Imperium/Wurst7', site: 'https://www.wurstclient.net', cat: 'Hacked Client', c: ['#f59e0b', '#92400e'], desc: 'Der Klassiker unter den Hacked Clients mit Hacks, Befehlen und Navigator.' },
  { id: 'liquid', name: 'LiquidBounce', repo: 'CCBlueX/LiquidBounce', site: 'https://liquidbounce.net', cat: 'Hacked Client', c: ['#38bdf8', '#075985'], desc: 'Open-Source-Client mit Scripting und vielen Modulen.' },
  { id: 'lambda', name: 'Lambda', repo: 'lambda-client/lambda', site: 'https://github.com/lambda-client/lambda', cat: 'Utility-Client', c: ['#34d399', '#065f46'], deps: [['fabric-language-kotlin', 'Fabric Language Kotlin']], desc: 'Moderner Kotlin-Client mit Automatisierung, Rendering und Befehlen (benötigt Baritone).' },
  { id: 'sealed', name: 'Sealed Client', repo: 'Ketchio-dev/sealed-client', site: 'https://github.com/Ketchio-dev/sealed-client', cat: 'Utility-Client', c: ['#fb7185', '#881337'], desc: 'Schlanker Fabric-Utility-Client mit Auto-Eat, Inventar-Tools und Anti-AFK.' },
  { id: 'baritone', name: 'Baritone', repo: 'cabaletta/baritone', site: 'https://github.com/cabaletta/baritone', cat: 'Pathfinding-Bot', c: ['#a3e635', '#3f6212'], desc: 'Läuft, baut ab und baut automatisch – ein Pathfinding-Bot.' }
];
const allCheats = () => [...CHEATS, ...getSet().customCheats];
ipcMain.handle('cheat:unlock', (_, pw) => String(pw).trim().toLowerCase() === 'warden');
ipcMain.handle('cheat:list', () => allCheats());
ipcMain.handle('cheat:addCustom', (_, { name, src }) => {
  name = String(name || '').trim(); src = String(src || '').trim();
  if (!name || !src) throw new Error('Name und Quelle (GitHub „owner/repo“ oder Direktlink zur .jar) angeben.');
  const c = { id: 'custom-' + crypto.randomBytes(3).toString('hex'), name, custom: true, cat: 'Eigener Client', c: ['#fb923c', '#7c2d12'], desc: 'Selbst hinzugefügt: ' + src };
  if (/^https?:\/\//i.test(src)) c.url = src; else if (/^[\w.-]+\/[\w.-]+$/.test(src)) { c.repo = src; c.site = 'https://github.com/' + src; } else throw new Error('Quelle muss „owner/repo“ oder ein https-Link sein.');
  const cur = getSet(); cur.customCheats.push(c); putSet(cur); return allCheats();
});
ipcMain.handle('cheat:removeCustom', (_, id) => { const cur = getSet(); cur.customCheats = cur.customCheats.filter(x => x.id !== id); putSet(cur); return allCheats(); });

const gh = async u => {
  const h = { ...UA, Accept: 'application/vnd.github+json' }, tk = getSet().ghToken; if (tk) h.Authorization = 'Bearer ' + tk;
  const r = await fetch(u, { headers: h });
  if (r.status === 403 || r.status === 429) throw new Error('GitHub-Limit erreicht – später erneut versuchen oder in den Einstellungen einen GitHub-Token eintragen.');
  if (!r.ok) throw new Error('GitHub-Fehler ' + r.status);
  return r.json();
};
const mcRe = mc => new RegExp('(?<![\\d.])' + mc.replace(/\./g, '\\.') + '(?!\\d|\\.\\d)');
async function findCheatJar(c, mc, force) {
  if (c.url) return { name: path.basename(new URL(c.url).pathname) || (c.id + '.jar'), url: c.url, exact: true };
  if (c.api) {
    try { const u = c.api.replace('{mc}', mc), r = await fetch(u, { headers: UA }); if (r.ok) { try { r.body && r.body.cancel(); } catch {} return { name: `${c.id}-${mc}.jar`, url: u, exact: true }; } } catch {}
  }
  if (!c.repo) throw new Error(`Keine passende Version für ${mc} gefunden.`);
  const re = mcRe(mc); let best = null, first = null;
  for (let page = 1; page <= 3; page++) {
    const rels = await gh(`https://api.github.com/repos/${c.repo}/releases?per_page=100&page=${page}`);
    if (!rels.length) break;
    for (const r of rels) {
      const jars = r.assets.filter(a => /\.jar$/i.test(a.name) && !/sources|javadoc|-dev\b|api-only/i.test(a.name));
      if (!jars.length) continue;
      const score = a => (/fabric/i.test(a.name) ? 4 : 0) + (/standalone/i.test(a.name) ? 1 : 0) - (/forge|neoforge|lexforge/i.test(a.name) ? 5 : 0);
      const ordered = [...jars].sort((a, b) => score(b) - score(a));
      if (!first) first = { name: ordered[0].name, url: ordered[0].browser_download_url };
      const byName = ordered.find(a => re.test(a.name));
      const lvl = byName ? 3 : re.test(`${r.tag_name} ${r.name || ''}`) ? 2 : re.test(String(r.body || '').slice(0, 800)) ? 1 : 0;
      if (lvl && (!best || lvl > best.lvl)) best = { lvl, name: (byName || ordered[0]).name, url: (byName || ordered[0]).browser_download_url };
      if (best && best.lvl === 3) return { ...best, exact: true };
    }
    if (rels.length < 100) break;
  }
  if (best) return { ...best, exact: best.lvl >= 2 };
  if (force && first) return { ...first, exact: false };
  throw new Error(`Keine passende Version für ${mc} gefunden.`);
}
ipcMain.handle('cheat:install', async (_, { id, mc, force, target }) => {
  const c = allCheats().find(x => x.id === id);
  if (!c) throw new Error('Client nicht gefunden.');
  let p, name, fresh = !target;
  if (target) {
    p = loadPack(target); name = target; mc = p.mc;
    if (p.loader !== 'fabric' && p.loader !== 'quilt') throw new Error(`„${target}“ nutzt ${p.loader}. Dieser Client braucht ein Fabric- oder Quilt-Profil.`);
  } else {
    name = `${c.name} ${mc}`; let n = 2; while (fs.existsSync(packFile(name))) name = `${c.name} ${mc} (${n++})`;
    p = { name, mc, loader: 'fabric', mods: [], last: 0 };
  }
  const pick = await findCheatJar(c, mc, force);
  const modsDir = path.join(gameDir(name), 'mods'), have = k => fs.existsSync(modsDir) && fs.readdirSync(modsDir).some(f => f.toLowerCase().includes(k)); // doppelte Mods vermeiden
  if (!have('fabric-api')) { try { await resolveMod(p, 'fabric-api', 'Fabric API'); } catch {} }
  for (const [slug, title] of c.deps || []) if (!have(slug)) { try { await resolveMod(p, slug, title); } catch (e) { log('Abhängigkeit übersprungen: ' + e.message); } }
  const mid = 'cheat:' + c.id, old = p.mods.find(m => m.id === mid);
  if (old) fs.rmSync(path.join(modsDir, path.basename(old.filename)), { force: true });
  p.mods = p.mods.filter(m => m.id !== mid);
  p.mods.push({ id: mid, title: c.name, filename: pick.name, url: pick.url });
  savePack(p);
  return { name, fresh, exact: pick.exact !== false };
});

// ---------- Divine: Konten & Shop (lokal auf diesem PC) ----------
const dbF = () => ud('divine.json');
const SEED_BADGES = [['Stern', '★', 0], ['Flamme', '♨', 40], ['Blitz', '⚡', 30], ['Krone', '♛', 50], ['Totenkopf', '☠', 80]].map(([name, symbol, price], i) => ({ id: 'seed' + i, name, type: 'badge', price, author: 'Divine', symbol }));
let SEEDS = null;
const seeds = () => SEEDS || (SEEDS = [...SEED_BADGES, ...[['Divine Ember', 'cape_ember', 0], ['Divine Gold', 'cape_gold', 60], ['Divine Night', 'cape_night', 90]].map(([name, f, price], i) => ({ id: 'seedcape' + i, name, type: 'cape', price, author: 'Divine', data: 'data:image/png;base64,' + fs.readFileSync(asset('capes', f + '.png')).toString('base64') }))]);
const db = () => {
  const d = fs.existsSync(dbF()) ? JSON.parse(fs.readFileSync(dbF(), 'utf8')) : { users: {}, session: null, items: [] };
  let ch = false; for (const s of seeds()) if (!d.items.some(i => i.id === s.id)) { d.items.push(s); ch = true; }
  if (ch) dbSave(d);
  return d;
};
const dbSave = d => fs.writeFileSync(dbF(), JSON.stringify(d));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const pub = (d, u) => { const c = d.items.find(i => i.id === u.cape && i.type === 'cape'); return { name: u.name, role: u.role, coins: u.coins, owned: u.owned, badge: u.badge, cape: c ? c.id : '', capeData: c ? c.data : '' }; };
const meU = d => { const u = d.users[d.session]; if (!u) throw new Error('Bitte im Shop anmelden.'); return u; };
ipcMain.handle('acc:me', () => { const d = db(), u = d.users[d.session]; return u ? pub(d, u) : null; });
ipcMain.handle('acc:register', (_, { name, pw, code }) => {
  name = String(name || '').trim(); const key = name.toLowerCase();
  if (!/^\w{3,16}$/.test(name)) throw new Error('Name: 3–16 Zeichen (Buchstaben, Zahlen, _).');
  if (String(pw || '').length < 4) throw new Error('Passwort: mindestens 4 Zeichen.');
  const d = db(); if (d.users[key]) throw new Error('Dieser Name ist schon vergeben.');
  let role = 'user';
  if (code && code.trim()) { if (code.trim().toLowerCase() === '3x3') role = 'creator'; else throw new Error('Ungültiger Code.'); }
  const salt = crypto.randomBytes(16).toString('hex');
  d.users[key] = { name, salt, hash: hashPw(pw, salt), role, coins: 110, owned: ['seed0', 'seedcape0'], badge: '', cape: '' };
  d.session = key; dbSave(d); return pub(d, d.users[key]);
});
ipcMain.handle('acc:login', (_, { name, pw }) => {
  const d = db(), key = String(name || '').trim().toLowerCase(), u = d.users[key];
  if (!u || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt)), Buffer.from(u.hash))) throw new Error('Name oder Passwort falsch.');
  d.session = key; dbSave(d); return pub(d, u);
});
ipcMain.handle('acc:logout', () => { const d = db(); d.session = null; dbSave(d); });
ipcMain.handle('shop:list', () => db().items);
ipcMain.handle('shop:upload', async (_, { name, type, price, symbol }) => {
  const d = db(), u = meU(d);
  if (u.role !== 'creator') throw new Error('Nur Creator dürfen hochladen.');
  name = String(name || '').trim().slice(0, 30); if (!name) throw new Error('Gib einen Namen an.');
  const it = { id: crypto.randomUUID(), name, type, price: Math.max(0, Math.min(9999, parseInt(price) || 0)), author: u.name };
  if (type === 'badge') { it.symbol = [...String(symbol || '')].slice(0, 2).join(''); if (!it.symbol) throw new Error('Gib ein Symbol an.'); }
  else {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'PNG', extensions: ['png'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) throw new Error('Keine Datei gewählt.');
    const b = fs.readFileSync(r.filePaths[0]);
    if (b.length > 1e6 || b.subarray(1, 4).toString() !== 'PNG') throw new Error('Bitte ein PNG unter 1 MB wählen.');
    it.data = 'data:image/png;base64,' + b.toString('base64');
  }
  d.items.push(it); u.owned.push(it.id); dbSave(d); return it.id;
});
ipcMain.handle('shop:buy', (_, id) => {
  const d = db(), u = meU(d), it = d.items.find(x => x.id === id);
  if (!it) throw new Error('Item nicht gefunden.');
  if (u.owned.includes(id)) return pub(d, u);
  if (u.coins < it.price) throw new Error('Nicht genug Coins.');
  u.coins -= it.price; u.owned.push(id); dbSave(d); return pub(d, u);
});
ipcMain.handle('shop:delete', (_, id) => { const d = db(), u = meU(d), it = d.items.find(x => x.id === id); if (!it || it.author !== u.name) throw new Error('Das kannst du nicht löschen.'); d.items = d.items.filter(x => x.id !== id); dbSave(d); });
ipcMain.handle('shop:badge', (_, id) => {
  const d = db(), u = meU(d);
  if (!id) u.badge = ''; else { const it = d.items.find(x => x.id === id); if (!it || it.type !== 'badge' || !u.owned.includes(id)) throw new Error('Badge nicht im Besitz.'); u.badge = it.symbol; }
  dbSave(d); return pub(d, u);
});
ipcMain.handle('shop:cape', (_, id) => { // gekaufte Cape tragen → erscheint im Avatar
  const d = db(), u = meU(d);
  if (!id) u.cape = ''; else { const it = d.items.find(x => x.id === id); if (!it || it.type !== 'cape' || !u.owned.includes(id)) throw new Error('Cape nicht im Besitz.'); u.cape = id; }
  dbSave(d); return pub(d, u);
});
ipcMain.handle('shop:toSkin', (_, id) => {
  const d = db(), u = meU(d), it = d.items.find(x => x.id === id);
  if (!it || it.type !== 'skin' || !u.owned.includes(id)) throw new Error('Skin nicht im Besitz.');
  fs.mkdirSync(ud('skins'), { recursive: true });
  const f = safe(it.name) + '.png';
  fs.writeFileSync(path.join(ud('skins'), f), Buffer.from(it.data.split(',')[1], 'base64')); return f;
});

// ---------- Mojang-Capes ----------
ipcMain.handle('capes:list', async () => {
  if (!session) return [];
  const p = await (await fetch(MS + '/minecraft/profile', { headers: { Authorization: 'Bearer ' + tok() } })).json();
  return Promise.all((p.capes || []).map(async c => ({ id: c.id, alias: c.alias, active: c.state === 'ACTIVE', data: 'data:image/png;base64,' + Buffer.from(await (await fetch(c.url)).arrayBuffer()).toString('base64') })));
});
ipcMain.handle('capes:set', async (_, id) => {
  if (!session) throw new Error('Bitte zuerst anmelden.');
  const r = await fetch(MS + '/minecraft/profile/capes/active', { method: id ? 'PUT' : 'DELETE', headers: { Authorization: 'Bearer ' + tok(), 'Content-Type': 'application/json' }, body: id ? JSON.stringify({ capeId: id }) : undefined });
  if (!r.ok) throw new Error('Cape konnte nicht gesetzt werden: ' + r.status);
});
