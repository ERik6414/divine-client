package de.divine;

import java.io.File;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.multiplayer.MultiplayerScreen;
import net.minecraft.client.gui.screen.option.OptionsScreen;
import net.minecraft.client.gui.screen.world.SelectWorldScreen;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.util.Util;

public class DivineMod implements ClientModInitializer {
  @Override
  public void onInitializeClient() {
    ScreenEvents.AFTER_INIT.register((client, screen, w, h) -> {
      if (!(screen instanceof TitleScreen)) return;
      var btns = Screens.getButtons(screen);
      btns.removeIf(b -> b.getWidth() >= 98); // Vanilla-Hauptbuttons entfernen
      int bw = 240, bh = 24, x = w / 2 - bw / 2, y = h / 4 + 40, s = bh + 4;
      btns.add(new DivineButton(x, y, bw, bh, Text.literal("Einzelspieler"), b -> client.setScreen(new SelectWorldScreen(screen)), false));
      btns.add(new DivineButton(x, y + s, bw, bh, Text.literal("Mehrspieler"), b -> client.setScreen(new MultiplayerScreen(screen)), false));
      btns.add(new DivineButton(x, y + 2 * s, bw, bh, Text.literal("Screenshots"), b -> Util.getOperatingSystem().open(new File(client.runDirectory, "screenshots")), false));
      btns.add(new DivineButton(x, y + 3 * s, bw, bh, Text.literal("Optionen"), b -> client.setScreen(new OptionsScreen(screen, client.options)), false));
      btns.add(new DivineButton(x, y + 4 * s, bw, bh, Text.literal("Divine Settings"), b -> client.setScreen(new DivineScreen(screen)), true));
      btns.add(new DivineButton(x + 30, y + 5 * s + 8, bw - 60, 20, Text.literal("§cSpiel beenden"), b -> client.scheduleStop(), false));
      ScreenEvents.afterRender(screen).register((sc, ctx, mx, my, delta) -> {
        ctx.fill(w - 150, 10, w - 10, 34, 0xE60E0807);
        ctx.fill(w - 150, 10, w - 147, 34, 0xFFFF9F1C);
        ctx.drawTextWithShadow(client.textRenderer, Text.literal(client.getSession().getUsername()), w - 140, 18, 0xFFFFFF);
        ctx.drawCenteredTextWithShadow(client.textRenderer, Text.literal("Divine · by ErikFCH1965").formatted(Formatting.GOLD), w / 2, h - 22, 0xFFFFFF);
      });
    });
  }
}
