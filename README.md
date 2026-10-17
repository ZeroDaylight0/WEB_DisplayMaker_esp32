# PixelForge

PixelForge is a browser-based editor for small displays used with Arduino and ESP boards. It provides a pixel-sized preview, editable layers, project files, image export, and starter code for supported display drivers.

## Run locally

```sh
npm ci
# Terminal 1
npm run dev:api
# Terminal 2
npm run dev
```

Use Node.js 22.12 or later. The Vite development server proxies `/api` to the local account API on port 4174. Account and project data is stored in `data/pixelforge.sqlite` by default. On first startup, existing accounts and projects in `data/accounts.json` are imported into SQLite; the JSON file is retained as a backup and is not imported again. Stop the server before copying the SQLite database for a backup. Set `PIXELFORGE_DATA_DIR` to keep data outside the application directory. For production, build with `npm run build`, then start the combined API/static server with `NODE_ENV=production npm start`; put it behind HTTPS before exposing it to the internet.

## Desktop launchers

- Windows: run [`start-windows.bat`](./start-windows.bat). It installs dependencies if needed, builds the site, and starts the production server.
- Linux: run `sh ./start-linux.sh` from the project folder. The server stays attached to that terminal; press Ctrl+C to stop it.
- Ubuntu autostart: log in as the desktop user and run `sh ./install-ubuntu-autostart.sh` from the project folder (do not use `sudo`). The installer uses its own folder as the project directory by default and creates and enables a per-user systemd service; account data is stored under `~/.local/share/pixelforge`. To use a different project folder, set `PIXELFORGE_DIR` before running the installer.

Build and test (also run automatically on pushes and pull requests):

```sh
npm run build
npm test
npm run test:server
```

## Using the editor

- Choose a display in the left panel, or create a custom screen with a resolution from 8 to 2048 pixels.
- Add text, rounded rectangles, circles, lines, or a PNG/JPEG/WebP/GIF image (up to 2 MB). Drag elements to move them; use the selection handle or the properties panel to resize and adjust them.
- Change text, font size, weight, color, and shape radius in the properties panel. Use the layers tab to select an object and the layer controls to reorder, duplicate, or delete it.
- Projects autosave in this browser. Create an account or sign in, then use **Сохранить веб-проект** to sync the current design and the account panel to open or delete cloud projects. **Экспорт JSON** and **Открыть** remain portable, local project-file operations; firmware code import/export is separate. Accounts are stored locally by this server (they are not a hosted service); passwords use scrypt hashes, while project documents are stored as JSON.
- Undo project edits with **Ctrl+Z** (or **Cmd+Z** on macOS); redo with **Ctrl+Y** or **Ctrl+Shift+Z** (**Cmd** equivalents on macOS). Copy and paste the selected canvas object with **Ctrl+C** and **Ctrl+V** (or **Cmd** equivalents). Text-entry fields keep their native undo and clipboard behavior.
- Zoom the complete display frame with the toolbar controls or **Ctrl+mouse wheel** (**Cmd+mouse wheel** on macOS); the enlarged display can be scrolled in the canvas area. Conditional preview states are arranged in a responsive grid rather than a single horizontal strip.
- Use **Загрузить код** to paste or load an Arduino sketch (`.ino`, `.cpp`, `.h`) or ESPHome YAML. The importer recognizes common literal-coordinate drawing calls from U8g2, TFT_eSPI, Adafruit_GFX/Arduino_GFX, and ESPHome display lambdas, then creates editable canvas elements. U8g2 named font variants, baseline coordinates, centered `drawStr` text, cursor-based printing, and variable cursor positions such as `getCursorX()` are included in the preview; baseline placement keeps text drawn on the last display row from being clipped by the SVG canvas. Serial logging is excluded from drawing-command warnings. Static monochrome `drawBitmap`, `drawXBitmap`, and U8g2 XBM arrays are rendered in the preview and retain their original API call when position or size changes; triangle drawing calls are previewed as triangles instead of bounding boxes. SSD1309 U8g2 sources are identified as 128×64 monochrome displays. Simple counted `for` loops around horizontal or vertical lines are shown as repeated strokes while the original loop is retained in exported firmware. ESPHome preview text uses font sizes declared under `font:`, measures imported text with the browser's matching font metrics, applies ESPHome's top-left default text anchor and explicit `TextAlign` anchors, and shows representative samples for dynamic values where their source expressions can be followed. Samples are illustrative only—the editor is not connected to live sensor or MQTT values. Outline drawing calls remain unfilled, while filled calls retain their fill and color. Objects outside the physical display bounds are reported in the canvas status instead of being silently moved. It uses the YAML display platform/model (for example, `ssd1306_i2c` with `SSD1306 128x64`) to identify the display rather than guessing an unrelated board from a controller name. Conditional branches are imported as separate preview states and can be switched above the screen; selecting a nested condition activates its required parent branches, simple `if` blocks default to their drawable branch, and mutually exclusive `else-if` chains without a matching default start with no branch selected. For dynamic text linked to an `id(...)` assigned in an MQTT `on_message` handler, the properties panel shows the matching topic and lets you edit it; the downloaded YAML updates only that topic value. MQTT settings include only subscribed variables that are actually displayed, not handler bookkeeping such as flags and timers. After editing, the downloaded source is the original file with recognized drawing calls patched in place; unrelated code, pin setup, sensors, and application logic are retained.
- Code analysis is intentionally conservative. Dynamic bitmap expressions, custom helpers, and unsupported drawing functions stay in the source untouched and are reported as warnings; they cannot be faithfully reconstructed as visual objects. Firmware export changes drawing calls only—it does not rewrite the source's driver initialization or hardware wiring.
- Export the screen as PNG or SVG, or open the code generator for an Arduino `.ino` sketch or an ESPHome YAML snippet.

## Display and code support

The catalog includes representative SSD1306/SH1106/SSD1327/SSD1331 OLED, ST7735/ST7789/ILI9341/ILI9488/GC9A01/ILI9225 TFT, Waveshare e-paper, and MAX7219 LED matrix presets, as well as board profiles for CYD, TTGO/LILYGO T-Display, T-Embed, T-Deck, and M5Stack Core2. The list is intentionally extensible rather than a claim to enumerate every module or board revision; custom display dimensions can be used for the visual editor and image exports.

Arduino snippets use U8g2 for configured monochrome OLED presets and Arduino_GFX for configured color presets. ESPHome snippets are generated only for configured controller/platform mappings, including SSD1306/SH1106/SSD1327, ST7789, ILI9xxx, Waveshare e-paper, and MAX7219. Other combinations show as unsupported instead of emitting a success-shaped placeholder.

Generated source is a starting point, not a board-specific firmware image: verify the controller variant, wiring, offsets, display orientation, library version, memory requirements, and ESPHome configuration against your actual hardware. The code samples use example ESP32 pins. Imported raster images remain in the visual project and image exports; firmware generators mark them as not converted to a bitmap. Firmware font families are mapped to library fonts, and ESPHome rectangles are exported without corner rounding.
