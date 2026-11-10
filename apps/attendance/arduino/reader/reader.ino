// 출근부 카드 리더: Arduino Uno/Nano + MFRC522(RC522) 모듈.
// 카드를 대면 UID를 16진수 대문자 한 줄로 USB 시리얼(9600 baud)에 보낸다. 예: "04A1B2C3\n"
// 시리얼을 읽어 Worker로 전송하는 쪽은 ../../pi/reader.py (ARDUINO_SERIAL=/dev/ttyACM0).
//
// 라이브러리: Arduino IDE 라이브러리 관리자에서 "MFRC522"(GithubCommunity) 설치.
//
// 배선 (Uno/Nano, RC522는 3.3V 전원):
//   RC522 SDA(SS) -> D10    SCK -> D13    MOSI -> D11    MISO -> D12
//   RC522 RST     -> D9     3.3V -> 3.3V  GND  -> GND    (IRQ 미사용)
//   부저(선택)    -> D7 (능동 부저 + , - 는 GND)

#include <SPI.h>
#include <MFRC522.h>

constexpr uint8_t SS_PIN = 10;
constexpr uint8_t RST_PIN = 9;
constexpr uint8_t BUZZER_PIN = 7;
// 카드를 계속 대고 있어도 한 번만 보내도록 같은 카드의 재전송을 막는 시간.
constexpr unsigned long REPEAT_GUARD_MS = 2000;
constexpr unsigned long BEEP_MS = 80;

MFRC522 reader(SS_PIN, RST_PIN);
byte lastUid[10];
byte lastUidSize = 0;
unsigned long lastSentAt = 0;

void setup() {
  Serial.begin(9600);
  pinMode(BUZZER_PIN, OUTPUT);
  SPI.begin();
  reader.PCD_Init();
}

void loop() {
  if (!reader.PICC_IsNewCardPresent() || !reader.PICC_ReadCardSerial()) return;

  const MFRC522::Uid& uid = reader.uid;
  const bool sameCard = uid.size == lastUidSize && memcmp(uid.uidByte, lastUid, uid.size) == 0;
  if (!(sameCard && millis() - lastSentAt < REPEAT_GUARD_MS)) {
    for (byte i = 0; i < uid.size; i++) {
      if (uid.uidByte[i] < 0x10) Serial.print('0');
      Serial.print(uid.uidByte[i], HEX);
    }
    Serial.println();
    memcpy(lastUid, uid.uidByte, uid.size);
    lastUidSize = uid.size;
    lastSentAt = millis();

    digitalWrite(BUZZER_PIN, HIGH);
    delay(BEEP_MS);
    digitalWrite(BUZZER_PIN, LOW);
  }

  reader.PICC_HaltA();
  reader.PCD_StopCrypto1();
}
