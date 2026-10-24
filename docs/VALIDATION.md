# DY PHONE 공개 전 확인

웹 UI 확인일: 2026-10-24 / APK 확인일: 2026-10-25 (Asia/Seoul)

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

- Android 실기기 설치·실행 (연결된 실기기 없음).
- 모델 파일 다운로드, LiteRT-LM 네이티브 추론, 이미지 이해, 속도·메모리·배터리 사용량.
- Android 카메라·통화·문자·백그라운드 서비스, 전체 문서 형식의 내보내기·미리보기.

화면 및 소스 검사를 위 기능의 실기기 검증으로 해석하면 안 됩니다.

## 2026-10-25 APK 릴리스 확인

- JDK 17 + Gradle 8.14.2 + Android Gradle Plugin 8.13.2 + Kotlin 2.3.10 + Android SDK Platform 34로 `assembleRelease` 성공. 한글 Windows 경로에서는 `-Pandroid.overridePathCheck=true` 사용.
- APK application ID `com.dyagent.mobile`, 표시 이름 `DY PHONE`, versionCode `40`, versionName `3.19` 확인. 배포 태그는 `v3.19.0`.
- 별도 릴리스 키로 서명. APK Signature Scheme v2/v3 검증 및 `zipalign -c -v 4` 통과.
- APK ZIP 무결성 검사 통과. 주요 웹 자산이 소스와 바이트 동일하고 Capacitor 앱 이름이 DY PHONE임을 확인.
- 모델 다운로드 URL에 HEAD 요청이 HTTP 200을 반환하며 파일 크기는 2,588,147,712바이트임을 확인. 모델 전체 다운로드 또는 모델 추론 검증은 수행하지 않음.
- 개인 서명 키·비밀번호·로컬 SDK 설정은 공개 소스와 APK에 포함하지 않음.

서명 인증서 SHA-256:

```text
31aa1c077e610de2aaeb1a702b07086d4b6711b04ec9e5811e09e07d7ab80736
```

| 파일 | 바이트 | 네이티브 ABI | SHA-256 |
| --- | ---: | --- | --- |
| DY-PHONE-3.19.0-arm64-v8a.apk | 28383271 | arm64-v8a | `1e20290f389eed190e33d431336ae5d3f021546f4688a65c99c70762ddeef30f` |
| DY-PHONE-3.19.0-universal.apk | 53033630 | arm64-v8a, x86_64 | `2a9f8b04ca3fdce251bc85259c01d26f49f83813d024420fedec851a980d36ad` |

Android 실기기 설치·실행, 네이티브 플러그인의 실제 동작, 기기별 모델 추론은 여전히 미검증입니다. APK 서명과 패키지 검사는 실기기 동작 검증을 대신하지 않습니다.

추가 정적 검사: `:app:lintRelease` 통과. 오류 0건, 경고 33건. 경고는 검사 보고서에 남아 있으며 전체 경고가 해소된 상태는 아닙니다.
