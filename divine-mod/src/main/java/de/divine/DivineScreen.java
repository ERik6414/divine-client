package de.divine;

import java.util.function.Supplier;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

public class DivineScreen extends Screen {
  private final Screen parent;
  private static final int[] FOV = {70, 90, 110}, DIST = {8, 12, 16, 24}, FPS = {60, 144, 260};

  public DivineScreen(Screen parent) { super(Text.literal("Divine Settings")); this.parent = parent; }

  private static int next(int[] a, int cur) { for (int v : a) if (v > cur) return v; return a[0]; }

  private void row(int x, int y, String label, Supplier<String> val, Runnable act) {
    addDrawableChild(ButtonWidget.builder(Text.literal(label + ": " + val.get()), b -> {
      act.run();
      b.setMessage(Text.literal(label + ": " + val.get()));
      MinecraftClient.getInstance().options.write();
    }).dimensions(x, y, 150, 20).build());
  }

  @Override
  protected void init() {
    var o = MinecraftClient.getInstance().options;
    int x1 = width / 2 - 155, x2 = width / 2 + 5, y = height / 2 - 50;
    row(x1, y, "FOV", () -> String.valueOf(o.getFov().getValue()), () -> o.getFov().setValue(next(FOV, o.getFov().getValue())));
    row(x2, y, "Sichtweite", () -> String.valueOf(o.getViewDistance().getValue()), () -> o.getViewDistance().setValue(next(DIST, o.getViewDistance().getValue())));
    row(x1, y + 26, "Max FPS", () -> o.getMaxFps().getValue() >= 260 ? "Unbegrenzt" : String.valueOf(o.getMaxFps().getValue()), () -> o.getMaxFps().setValue(next(FPS, o.getMaxFps().getValue())));
    row(x2, y + 26, "Helligkeit", () -> o.getGamma().getValue() > 0.75 ? "Hell" : "Normal", () -> o.getGamma().setValue(o.getGamma().getValue() > 0.75 ? 0.5 : 1.0));
    row(x1, y + 52, "Sprint-Toggle", () -> o.getSprintToggled().getValue() ? "AN" : "AUS", () -> o.getSprintToggled().setValue(!o.getSprintToggled().getValue()));
    addDrawableChild(ButtonWidget.builder(Text.literal("Zurück"), b -> close()).dimensions(width / 2 - 75, y + 92, 150, 20).build());
  }

  @Override
  public void renderBackground(DrawContext c, int mx, int my, float d) {
    super.renderBackground(c, mx, my, d);
    int w = 340, x = width / 2 - w / 2, y = height / 2 - 100;
    c.fill(x, y, x + w, y + 215, 0xE6140A08);
    c.fill(x, y, x + w, y + 2, 0xFFFF9F1C);
    c.drawCenteredTextWithShadow(textRenderer, Text.literal("DIVINE SETTINGS").formatted(Formatting.GOLD, Formatting.BOLD), width / 2, y + 12, 0xFFFFFF);
    c.drawCenteredTextWithShadow(textRenderer, Text.literal("by ErikFCH1965").formatted(Formatting.GRAY), width / 2, y + 24, 0xFFFFFF);
  }

  @Override
  public void close() { MinecraftClient.getInstance().setScreen(parent); }
}
