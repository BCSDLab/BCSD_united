// 출근부 리더 (PN532): KOREATECH 앱(HCE)이 켜진 폰과 일반 NFC 카드를 모두 읽는다.
// 읽은 ID를 USB 시리얼(9600 baud)에 한 줄로 보낸다. 시리얼 쪽은 ../../pi/reader.py (ARDUINO_SERIAL=…).
//   - KOREATECH 앱: 학번(숫자, 앞 0 제거). 예: "20210123"
//   - 일반 카드/태그: UID 16진수 대문자. 예: "04A1B2C3"
//
// 앱 응답 형식과 AID는 ../../README.md 의 "KOREATECH 앱(폰)" 절을 따른다.
// 폰은 화면이 켜져 있어야 응답한다. 앱에 로그인되어 있지 않으면 학번이 전부 0이라 무시한다.
//
// 라이브러리: 라이브러리 관리자에서 "Adafruit PN532" 설치.
// 배선 (Uno/Nano, PN532 모듈의 스위치를 I2C로): SDA->A4, SCL->A5, 5V, GND, IRQ->D2, RSTO(RESET)->D3
// 부저(선택): D7 (능동 부저 +, - 는 GND)
//
// RC522(MFRC522)는 ISO-DEP(APDU) 교환이 안정적이지 않아 폰(HCE) 읽기에는 PN532를 쓴다.

#include <Wire.h>
#include <Adafruit_PN532.h>

constexpr uint8_t PN532_IRQ = 2;
constexpr uint8_t PN532_RESET = 3;
constexpr uint8_t BUZZER_PIN = 7;
constexpr unsigned long REPEAT_GUARD_MS = 3000;
constexpr unsigned long BEEP_MS = 80;
constexpr uint8_t STUDENT_ID_DIGITS = 13;

// SELECT AID: D4 10 00 00 39 53 31 53 49 49 44 (앱 apduservice.xml의 AID)
const uint8_t SELECT_APDU[] = {0x00, 0xA4, 0x04, 0x00, 0x0B, 0xD4, 0x10, 0x00, 0x00, 0x39, 0x53, 0x31, 0x53, 0x49, 0x49, 0x44, 0x00};
// READ BINARY: 앱은 이 APDU에 학번을 평문으로 응답한다.
const uint8_t READ_APDU[] = {0x00, 0xB2, 0x01, 0x0C, 0x10};

Adafruit_PN532 nfc(PN532_IRQ, PN532_RESET);
char lastId[33];
unsigned long lastSentAt = 0;

void beep() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(BEEP_MS);
  digitalWrite(BUZZER_PIN, LOW);
}

// 앱 응답(18B: BCD 8B + 0x00 8B + 90 00)에서 학번 숫자열을 꺼낸다. 유효하지 않으면 false.
bool parseStudentId(const uint8_t* resp, uint8_t len, char* out) {
  if (len < 10 || resp[len - 2] != 0x90 || resp[len - 1] != 0x00) return false;
  char digits[STUDENT_ID_DIGITS + 1];
  for (uint8_t i = 0; i < STUDENT_ID_DIGITS; i++) {
    const uint8_t nibble = (i % 2 == 0) ? resp[i / 2] >> 4 : resp[i / 2] & 0x0F;
    if (nibble > 9) return false;
    digits[i] = '0' + nibble;
  }
  digits[STUDENT_ID_DIGITS] = '\0';
  const char* start = digits;
  while (*start == '0') start++;
  if (*start == '\0') return false;  // 앱에 로그인되지 않은 폰(전부 0)은 유효 ID가 아니다.
  strcpy(out, start);
  return true;
}

void setup() {
  Serial.begin(9600);
  pinMode(BUZZER_PIN, OUTPUT);
  nfc.begin();
  if (!nfc.getFirmwareVersion()) {
    Serial.println("PN532 not found");
    while (true) delay(1000);
  }
  nfc.SAMConfig();
}

void loop() {
  uint8_t uid[7];
  uint8_t uidLength;
  if (!nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 200)) return;

  char id[33];
  bool found = false;

  uint8_t resp[32];
  uint8_t respLength = sizeof(resp);
  // 폰(HCE)은 SELECT AID에 응답하고, 일반 카드는 실패한다. SELECT 응답 내용은 쓰지 않는다.
  if (nfc.inDataExchange(const_cast<uint8_t*>(SELECT_APDU), sizeof(SELECT_APDU), resp, &respLength)) {
    respLength = sizeof(resp);
    if (nfc.inDataExchange(const_cast<uint8_t*>(READ_APDU), sizeof(READ_APDU), resp, &respLength)) {
      found = parseStudentId(resp, respLength, id);
    }
  } else {
    // 일반 NFC 카드: UID를 ID로 쓴다. (SELECT 실패 후에는 타깃을 다시 잡아야 하므로 아래 대기에서 처리)
    for (uint8_t i = 0; i < uidLength; i++) sprintf(id + i * 2, "%02X", uid[i]);
    found = true;
  }

  if (found && !(strcmp(id, lastId) == 0 && millis() - lastSentAt < REPEAT_GUARD_MS)) {
    Serial.println(id);
    strcpy(lastId, id);
    lastSentAt = millis();
    beep();
  }
  delay(300);
}
