package de.divine;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;

public class DivineButton extends ButtonWidget {
  private final boolean primary;

  public DivineButton(int x, int y, int w, int h, Text text, PressAction action, boolean primary) {
    super(x, y, w, h, text, action, DEFAULT_NARRATION_SUPPLIER);
    this.primary = primary;
  }

  @Override
  public void renderWidget(DrawContext c, int mx, int my, float delta) {
    int x = getX(), y = getY(), w = getWidth(), h = getHeight();
    boolean hov = isHovered();
    if (primary) {
      c.fillGradient(x, y, x + w, y + h, hov ? 0xFFFF7A1A : 0xFFE0451F, hov ? 0xFFB82E12 : 0xFF8C1F12);
    } else {
      c.fill(x, y, x + w, y + h, hov ? 0xF02A1510 : 0xE60E0807);
      c.fill(x, y + h - 1, x + w, y + h, hov ? 0xFFFF9F1C : 0x33FFFFFF);
    }
    c.drawCenteredTextWithShadow(MinecraftClient.getInstance().textRenderer, getMessage(), x + w / 2, y + (h - 8) / 2, 0xFFFFFF);
  }
}
