// macOS 네이티브 알림 플러그인 (osascript 기반, 의존성 없음)
// 세션 완료 / 에러 / 권한 요청 시 Notification Center로 알림을 본냅니다.

const MESSAGES = {
  "session.idle": { title: "opencode", body: "작업이 완료되었습니다", sound: "Glass" },
  "session.error": { title: "opencode", body: "오류가 발생했습니다", sound: "Basso" },
  "permission.asked": { title: "opencode", body: "권한 승인이 필요합니다", sound: "Submarine" },
}

export default async ({ $ }) => {
  return {
    event: async ({ event }) => {
      const msg = MESSAGES[event.type]
      if (!msg) return
      await $`osascript -e 'display notification "${msg.body}" with title "${msg.title}" sound name "${msg.sound}"'`
        .quiet()
        .nothrow()
    },
  }
}
