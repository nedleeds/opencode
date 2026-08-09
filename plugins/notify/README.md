# notify

macOS Notification Center 알림. 세션이 끝났을 때, 오류가 났을 때, 권한 승인이
필요할 때 소리와 함께 알린다.

`osascript` 로만 동작하므로 의존성이 없다. macOS 전용 — 다른 OS 에서는
`osascript` 가 없어 알림이 조용히 무시된다(`.nothrow()`).

이벤트별 문구와 소리는 `index.js` 상단 `MESSAGES` 에서 바꾼다.
