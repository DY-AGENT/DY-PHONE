# DY PHONE 공개 전 확인

확인일: 2026-10-24 (Asia/Seoul)

## 통과한 확인

- `npm ci --ignore-scripts --no-audit --no-fund`: 잠금 파일로 의존성 설치.
- `npx cap sync android`: 웹 자산과 DY PHONE 설정을 Android 프로젝트로 복사하고 플러그인 연결 갱신.
- 앱 JavaScript 모듈 7개 구문 검사와 Android XML 파싱.
- Android 런처 이름, 액티비티 제목, Capacitor 앱 이름, HTML 제목, 인사말, 시스템 프롬프트, 모델 다운로드 및 생성 알림의 DY PHONE 표시.
- Android application ID `com.dyagent.mobile`와 기존 내부 저장 키 유지.
- 공개할 파일에서 개인 키 및 일반적인 토큰 패턴 검사. 개인 키·환경 파일·서명 설정·로컬 SDK 경로·node_modules는 제외.
- 원본 ZIP의 외부 라이브러리와 기존 PNG 35개는 바이트 동일.

## 실제 브라우저 동작

Chrome에서 로컬 웹 서버의 앱을 실행하고 412 × 892 CSS 픽셀 크기로 확인했습니다.

1. 제목과 대화 인사말에 DY PHONE 표시.
2. `12000 * 3 + 5000 계산해 줘` 입력 → mock 백엔드가 calculator 도구 호출 → `41000` 반환.
3. 메뉴 → 가상 OS 열기 → DY OS 앱 그리드 표시.
4. 코드 → 기본 JavaScript 예제 실행 → `1~10 합 = 55` 표시.

## 이미지 출처

`docs/images/chat-mobile.png`, `workspace-mobile.png`, `code-mobile.png`는 위 동작을 직접 수행한 실제 웹 UI 캡처입니다. `dy-phone-preview.png`는 이 세 이미지를 배치하고 제목·설명을 추가한 미리보기입니다. 화면 내용이나 모델 응답을 합성하지 않았습니다. `mock (dev)` 표시는 데모 백엔드라는 뜻입니다.

## 이번에 확인하지 않은 범위

- Android APK 빌드·설치·실기기 실행 (현재 환경에 JDK 17 / Android SDK가 준비되어 있지 않음).
- 모델 파일 다운로드, LiteRT-LM 네이티브 추론, 이미지 이해, 속도·메모리·배터리 사용량.
- Android 카메라·통화·문자·백그라운드 서비스, 전체 문서 형식의 내보내기·미리보기.

화면 및 소스 검사를 위 기능의 실기기 검증으로 해석하면 안 됩니다.
