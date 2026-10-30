/*
  ESP32-C3 Super Mini + 2.8" 240x320 ILI9341 SPI
  Live inverter power from Home Assistant MQTT.

  Arduino IDE libraries:
    - Arduino_GFX_Library
    - PubSubClient

  Install/select the ESP32 Arduino core by Espressif. Set Wi-Fi and MQTT
  credentials below. MQTT is expected to be reachable from this device.

  Common ESP32-C3 Super Mini wiring:
    TFT SCK  -> GPIO 4
    TFT MOSI -> GPIO 6
    TFT MISO -> not connected
    TFT CS   -> GPIO 7
    TFT DC   -> GPIO 2
    TFT RST  -> GPIO 3
    TFT VCC  -> 3V3 (or 5V only if supported by your display module)
    TFT GND  -> GND
    TFT LED  -> 3V3 (backlight always on)

  The MQTT topic below is the topic provided by the user. If it is a
  Home Assistant entity_id rather than a broker topic, publish the sensor
  value to this topic from Home Assistant or change POWER_TOPIC accordingly.
*/

#include <Arduino_GFX_Library.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// ---- Fill these in for your network and MQTT broker ----
const char *WIFI_SSID = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *MQTT_HOST = "192.168.1.10";
constexpr uint16_t MQTT_PORT = 1883;
const char *MQTT_USER = "";
const char *MQTT_PASSWORD = "";
const char *POWER_TOPIC =
  "voltsinurproultraplus/DEV1A12C47CBD4876E/STATE_INVERTOR/output_active_power_w";

// ---- SPI pins for a common ESP32-C3 Super Mini ----
constexpr int8_t TFT_SCK = 4;
constexpr int8_t TFT_MOSI = 6;
constexpr int8_t TFT_MISO = -1;
constexpr int8_t TFT_CS = 7;
constexpr int8_t TFT_DC = 2;
constexpr int8_t TFT_RST = 3;

constexpr int16_t SCREEN_W = 240;
constexpr int16_t SCREEN_H = 320;
constexpr int16_t GAUGE_X = 120;
constexpr int16_t GAUGE_Y = 150;
constexpr int16_t GAUGE_R = 86;
constexpr float GAUGE_START_DEG = 135.0f;
constexpr float GAUGE_SWEEP_DEG = 270.0f;

constexpr uint16_t C_BG = 0x0841;
constexpr uint16_t C_PANEL = 0x10A3;
constexpr uint16_t C_PANEL_EDGE = 0x2145;
constexpr uint16_t C_TRACK = 0x2949;
constexpr uint16_t C_WHITE = 0xFFFF;
constexpr uint16_t C_MUTED = 0x9CF3;
constexpr uint16_t C_CYAN = 0x05FF;
constexpr uint16_t C_GREEN = 0x07E0;
constexpr uint16_t C_AMBER = 0xFD20;
constexpr uint16_t C_RED = 0xF986;

Arduino_DataBus *spiBus = new Arduino_ESP32SPI(
  TFT_DC, TFT_CS, TFT_SCK, TFT_MOSI, TFT_MISO, FSPI
);
Arduino_GFX *gfx = new Arduino_ILI9341(spiBus, TFT_RST, 0, false);

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

float powerW = 0.0f;
float displayPowerW = 0.0f;
float rangeMaxW = 1000.0f;
bool havePower = false;
bool needsRedraw = true;
uint32_t lastMqttAttemptMs = 0;
uint32_t lastWifiAttemptMs = 0;
uint32_t lastScreenUpdateMs = 0;
uint32_t lastMessageMs = 0;
bool lastDrawnOnline = false;

uint16_t interpolateColor(uint16_t from, uint16_t to, float amount) {
  amount = constrain(amount, 0.0f, 1.0f);
  const uint8_t fromR = (from >> 11) & 0x1F;
  const uint8_t fromG = (from >> 5) & 0x3F;
  const uint8_t fromB = from & 0x1F;
  const uint8_t toR = (to >> 11) & 0x1F;
  const uint8_t toG = (to >> 5) & 0x3F;
  const uint8_t toB = to & 0x1F;
  const uint8_t r = fromR + (toR - fromR) * amount;
  const uint8_t g = fromG + (toG - fromG) * amount;
  const uint8_t b = fromB + (toB - fromB) * amount;
  return (r << 11) | (g << 5) | b;
}

uint16_t colorForRatio(float ratio) {
  if (ratio < 0.55f) return interpolateColor(C_CYAN, C_GREEN, ratio / 0.55f);
  if (ratio < 0.82f) return interpolateColor(C_GREEN, C_AMBER, (ratio - 0.55f) / 0.27f);
  return interpolateColor(C_AMBER, C_RED, (ratio - 0.82f) / 0.18f);
}

float niceRange(float watts) {
  const float target = fmaxf(watts * 1.20f, 100.0f);
  const float exponent = powf(10.0f, floorf(log10f(target)));
  const float normalized = target / exponent;
  const float step = normalized <= 1.0f ? 1.0f
                    : normalized <= 2.0f ? 2.0f
                    : normalized <= 5.0f ? 5.0f : 10.0f;
  return step * exponent;
}

void drawArc(float fromDeg, float toDeg, uint16_t color, int16_t radius) {
  if (toDeg <= fromDeg) return;

  float previousAngle = fromDeg;
  int16_t previousX = GAUGE_X + lroundf(cosf(previousAngle * DEG_TO_RAD) * radius);
  int16_t previousY = GAUGE_Y + lroundf(sinf(previousAngle * DEG_TO_RAD) * radius);

  for (float angle = fromDeg + 2.5f; angle <= toDeg + 0.01f; angle += 2.5f) {
    const float currentAngle = fminf(angle, toDeg);
    const int16_t currentX = GAUGE_X + lroundf(cosf(currentAngle * DEG_TO_RAD) * radius);
    const int16_t currentY = GAUGE_Y + lroundf(sinf(currentAngle * DEG_TO_RAD) * radius);

    for (int8_t thickness = -3; thickness <= 3; thickness += 2) {
      const int16_t offsetX = lroundf(-sinf(currentAngle * DEG_TO_RAD) * thickness);
      const int16_t offsetY = lroundf(cosf(currentAngle * DEG_TO_RAD) * thickness);
      const int16_t oldOffsetX = lroundf(-sinf(previousAngle * DEG_TO_RAD) * thickness);
      const int16_t oldOffsetY = lroundf(cosf(previousAngle * DEG_TO_RAD) * thickness);
      gfx->drawLine(
        previousX + oldOffsetX, previousY + oldOffsetY,
        currentX + offsetX, currentY + offsetY,
        color
      );
    }

    previousAngle = currentAngle;
    previousX = currentX;
    previousY = currentY;
    if (currentAngle >= toDeg) break;
  }
}

void drawScale(float maximum) {
  for (uint8_t tick = 0; tick <= 10; ++tick) {
    const float angle = (GAUGE_START_DEG + GAUGE_SWEEP_DEG * tick / 10.0f) * DEG_TO_RAD;
    const int16_t innerRadius = (tick % 2 == 0) ? 73 : 79;
    const int16_t x1 = GAUGE_X + lroundf(cosf(angle) * innerRadius);
    const int16_t y1 = GAUGE_Y + lroundf(sinf(angle) * innerRadius);
    const int16_t x2 = GAUGE_X + lroundf(cosf(angle) * 84);
    const int16_t y2 = GAUGE_Y + lroundf(sinf(angle) * 84);
    gfx->drawLine(x1, y1, x2, y2, tick % 2 == 0 ? C_WHITE : C_MUTED);

    if (tick % 2 == 0) {
      const uint32_t label = static_cast<uint32_t>(maximum * tick / 10.0f);
      const int16_t labelRadius = 61;
      const int16_t labelX = GAUGE_X + lroundf(cosf(angle) * labelRadius);
      const int16_t labelY = GAUGE_Y + lroundf(sinf(angle) * labelRadius);
      char text[8];
      if (maximum >= 10000.0f) snprintf(text, sizeof(text), "%luk", static_cast<unsigned long>(label / 1000));
      else if (maximum >= 1000.0f) snprintf(text, sizeof(text), "%lu", static_cast<unsigned long>(label));
      else snprintf(text, sizeof(text), "%lu", static_cast<unsigned long>(label));
      const int16_t textWidth = strlen(text) * 6;
      gfx->setTextSize(1);
      gfx->setTextColor(C_MUTED);
      gfx->setCursor(labelX - textWidth / 2, labelY - 3);
      gfx->print(text);
    }
  }
}

void drawStaticScreen(float maximum) {
  gfx->fillScreen(C_BG);
  gfx->fillRoundRect(8, 8, 224, 304, 18, C_PANEL);
  gfx->drawRoundRect(8, 8, 224, 304, 18, C_PANEL_EDGE);

  gfx->setTextSize(1);
  gfx->setTextColor(C_CYAN);
  gfx->setCursor(22, 20);
  gfx->print("INVERTER  /  LIVE");
  gfx->setTextSize(2);
  gfx->setTextColor(C_WHITE);
  gfx->setCursor(22, 38);
  gfx->print("OUTPUT POWER");
  gfx->drawFastHLine(22, 61, 196, C_PANEL_EDGE);

  drawScale(maximum);

  gfx->fillCircle(GAUGE_X, GAUGE_Y, 42, C_PANEL);
  gfx->drawCircle(GAUGE_X, GAUGE_Y, 42, C_PANEL_EDGE);
  gfx->setTextSize(1);
  gfx->setTextColor(C_MUTED);
  gfx->setCursor(94, 125);
  gfx->print("POWER");

  gfx->fillRoundRect(20, 238, 200, 61, 12, C_BG);
  gfx->drawRoundRect(20, 238, 200, 61, 12, C_PANEL_EDGE);
  gfx->setTextSize(1);
  gfx->setTextColor(C_MUTED);
  gfx->setCursor(35, 249);
  gfx->print("ACTIVE LOAD");
  gfx->fillRoundRect(35, 286, 170, 5, 2, C_TRACK);
}

void drawReadouts(float watts, float maximum, bool online) {
  const float ratio = constrain(watts / maximum, 0.0f, 1.0f);
  const float endDeg = GAUGE_START_DEG + GAUGE_SWEEP_DEG * ratio;
  const uint16_t activeColor = colorForRatio(ratio);

  drawArc(GAUGE_START_DEG, GAUGE_START_DEG + GAUGE_SWEEP_DEG, C_TRACK, GAUGE_R);
  drawArc(GAUGE_START_DEG, endDeg, activeColor, GAUGE_R);

  gfx->fillCircle(GAUGE_X, GAUGE_Y, 39, C_PANEL);
  gfx->setTextSize(1);
  gfx->setTextColor(C_MUTED);
  gfx->setCursor(96, 133);
  gfx->print("OUTPUT");
  gfx->setTextSize(3);
  gfx->setTextColor(C_WHITE);
  char gaugeText[8];
  if (watts >= 10000.0f) snprintf(gaugeText, sizeof(gaugeText), "%luk", static_cast<unsigned long>(watts / 1000.0f));
  else snprintf(gaugeText, sizeof(gaugeText), "%lu", static_cast<unsigned long>(watts));
  const int16_t gaugeWidth = strlen(gaugeText) * 18;
  gfx->setCursor((SCREEN_W - gaugeWidth) / 2, 148);
  gfx->print(gaugeText);

  gfx->fillRect(30, 261, 180, 22, C_BG);
  gfx->setTextSize(4);
  gfx->setTextColor(activeColor);
  char valueText[16];
  if (watts >= 10000.0f) {
    const uint32_t tenths = static_cast<uint32_t>(watts / 100.0f);
    snprintf(valueText, sizeof(valueText), "%lu.%lukW",
      static_cast<unsigned long>(tenths / 10),
      static_cast<unsigned long>(tenths % 10));
  } else {
    snprintf(valueText, sizeof(valueText), "%lu W", static_cast<unsigned long>(watts));
  }
  const int16_t valueWidth = strlen(valueText) * 24;
  gfx->setCursor((SCREEN_W - valueWidth) / 2, 263);
  gfx->print(valueText);

  gfx->fillRoundRect(35, 286, 170, 5, 2, C_TRACK);
  const uint16_t barWidth = static_cast<uint16_t>(ratio * 170.0f);
  if (barWidth > 0) gfx->fillRoundRect(35, 286, barWidth, 5, 2, activeColor);

  gfx->fillCircle(36, 302, 3, online ? C_GREEN : C_RED);
  gfx->setTextSize(1);
  gfx->setTextColor(online ? C_GREEN : C_RED);
  gfx->setCursor(44, 299);
  gfx->print(online ? "MQTT CONNECTED" : "WAITING FOR MQTT");
}

void onMqttMessage(char *topic, byte *payload, unsigned int length) {
  if (strcmp(topic, POWER_TOPIC) != 0 || length == 0 || length >= 32) return;

  char value[32];
  memcpy(value, payload, length);
  value[length] = '\0';
  char *end = nullptr;
  const float parsed = strtof(value, &end);
  if (end == value || !isfinite(parsed)) return;

  powerW = fmaxf(parsed, 0.0f);
  havePower = true;
  lastMessageMs = millis();

  const float desiredRange = niceRange(powerW);
  if (desiredRange > rangeMaxW || (desiredRange < rangeMaxW * 0.5f && desiredRange >= 100.0f)) {
    rangeMaxW = desiredRange;
    drawStaticScreen(rangeMaxW);
  }
  needsRedraw = true;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED || millis() - lastWifiAttemptMs < 10000) return;
  lastWifiAttemptMs = millis();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected() || millis() - lastMqttAttemptMs < 5000) return;
  lastMqttAttemptMs = millis();
  const String clientId = "inverter-display-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  bool connected;
  if (MQTT_USER[0] != '\0') connected = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD);
  else connected = mqtt.connect(clientId.c_str());
  if (connected) mqtt.subscribe(POWER_TOPIC, 0);
}

void drawPreviewSample() {
  gfx->fillScreen(0x0841);
  gfx->fillRoundRect(8, 8, 224, 304, 18, 0x10A3);
  gfx->drawRoundRect(8, 8, 224, 304, 18, 0x2145);
  gfx->setTextSize(1);
  gfx->setTextColor(0x05FF);
  gfx->setCursor(22, 20);
  gfx->print("INVERTER  /  LIVE");
  gfx->setTextSize(2);
  gfx->setTextColor(0xFFFF);
  gfx->setCursor(22, 38);
  gfx->print("OUTPUT POWER");
  gfx->drawFastHLine(22, 61, 196, 0x2145);
  gfx->drawCircle(120, 150, 86, 0x2949);
  gfx->drawCircle(120, 150, 79, 0x2949);
  gfx->drawLine(59, 211, 50, 200, 0x05FF);
  gfx->drawLine(50, 200, 43, 187, 0x05FF);
  gfx->drawLine(43, 187, 37, 174, 0x05FF);
  gfx->drawLine(37, 174, 35, 160, 0x05FF);
  gfx->drawLine(35, 160, 34, 145, 0x05FF);
  gfx->drawLine(34, 145, 36, 131, 0x05FF);
  gfx->drawLine(36, 131, 40, 118, 0x05FF);
  gfx->drawLine(40, 118, 47, 105, 0x07E0);
  gfx->drawLine(47, 105, 55, 93, 0x07E0);
  gfx->drawLine(55, 93, 66, 83, 0x07E0);
  gfx->drawLine(66, 83, 78, 75, 0x07E0);
  gfx->drawLine(78, 75, 91, 69, 0x07E0);
  gfx->drawLine(91, 69, 105, 65, 0x07E0);
  gfx->drawLine(105, 65, 119, 64, 0xFD20);
  gfx->drawLine(119, 64, 133, 65, 0xFD20);
  gfx->drawLine(133, 65, 147, 68, 0xFD20);
  gfx->drawLine(147, 68, 161, 74, 0xFD20);
  gfx->drawLine(161, 74, 173, 82, 0xFD20);
  gfx->drawLine(59, 211, 67, 203, 0xFFFF);
  gfx->drawLine(37, 183, 49, 180, 0xFFFF);
  gfx->drawLine(116, 64, 124, 64, 0xFFFF);
  gfx->drawLine(191, 180, 203, 183, 0xFFFF);
  gfx->drawLine(173, 203, 181, 211, 0xFFFF);
  gfx->fillCircle(120, 150, 42, 0x10A3);
  gfx->drawCircle(120, 150, 42, 0x2145);
  gfx->setTextSize(1);
  gfx->setTextColor(0x9CF3);
  gfx->setCursor(94, 125);
  gfx->print("POWER");
  gfx->setTextSize(3);
  gfx->setTextColor(0xFFFF);
  gfx->setCursor(85, 148);
  gfx->print("1240");
  gfx->fillRoundRect(20, 238, 200, 61, 12, 0x0841);
  gfx->drawRoundRect(20, 238, 200, 61, 12, 0x2145);
  gfx->setTextSize(1);
  gfx->setTextColor(0x9CF3);
  gfx->setCursor(35, 249);
  gfx->print("ACTIVE LOAD");
  gfx->setTextSize(4);
  gfx->setTextColor(0xFD20);
  gfx->setCursor(52, 263);
  gfx->print("1240 W");
  gfx->fillRoundRect(35, 286, 170, 5, 2, 0x2949);
  gfx->fillRoundRect(35, 286, 102, 5, 2, 0xFD20);
  gfx->fillCircle(36, 302, 3, 0x07E0);
  gfx->setTextSize(1);
  gfx->setTextColor(0x07E0);
  gfx->setCursor(44, 299);
  gfx->print("MQTT CONNECTED");
}

void setup() {
  Serial.begin(115200);
  if (!gfx->begin(27000000)) {
    Serial.println("ILI9341 init failed; check display wiring.");
    while (true) delay(1000);
  }
  gfx->setRotation(0);
  drawStaticScreen(rangeMaxW);
  drawReadouts(0, rangeMaxW, false);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(128);
  mqtt.setKeepAlive(30);
  WiFi.setAutoReconnect(true);
  connectWifi();
}

void loop() {
  connectWifi();
  connectMqtt();
  if (mqtt.connected()) mqtt.loop();

  const uint32_t now = millis();
  if (now - lastScreenUpdateMs >= 300) {
    const bool online = mqtt.connected() && havePower && now - lastMessageMs < 30000;
    if (havePower) displayPowerW += (powerW - displayPowerW) * 0.28f;
    const bool valueMoving = havePower && fabsf(displayPowerW - powerW) > 1.0f;
    if (needsRedraw || online != lastDrawnOnline || valueMoving) {
      drawReadouts(displayPowerW, rangeMaxW, online);
      lastDrawnOnline = online;
    }
    lastScreenUpdateMs = now;
    needsRedraw = false;
  }
  delay(5);
}

#if 0
// Static 1240 W sample used only for PixelForge's canvas preview.
void pixelForgeCanvasPreview() {
  drawPreviewSample();
}
#endif
