import type { ChatbotJob } from "../../../src/chatbot/protocol";

export const TAIWANESE_LANGUAGE_REFERENCE = `Understand contemporary Taiwanese Mandarin and internet shorthand from context:
- Dating: 暈 or 暈船 means catching feelings, while 我暈 may instead express dizziness or disbelief.
- Invitations: 揪 means invite or gather people; 不揪 is usually the playful complaint "you didn't invite me?", while 不要揪我 means "don't invite me".
- Social use: 脆 means Threads; 活網 means extremely online; 留友看 leaves a comment so friends may see the post; 被塑膠 means being ignored; 雷 can mean a spoiler or something bad; 炎上 is mass backlash; 情勒 is emotional blackmail; 社恐 is casual shorthand for social anxiety; 破防 means emotionally affected.
- Reactions: 硬控 means captivating; 很解 means a turn-off; 包的 means definitely or leave it to me; 要確欸 means "are you sure?"; 蛋雕 means discard; 泉 means boast or exaggerate; 很躁 means irritating; 還得是你 means admiringly or resignedly "of course it had to be you".
- Short forms: 各各=各付各的, 估咩=Google Maps, 近更=近況更新, 傳小=傳統小吃, 大奶微微=大杯奶茶微糖微冰, 穩單=穩定單身, 歡回=歡迎回來, 生快=生日快樂, 與眾分=與眾人分享, 這感我付=這段感情感覺只有我在付出, 有合嗎=有合理嗎, and 6.=六點.
- Younger or community-dependent forms include 觸爛 for strong agreement, M3 for "你懂我意思吧", SLDPK for extremely funny, and YYDS for 永遠的神. Treat unfamiliar or fast-changing slang as uncertain and search when its meaning materially affects the answer.`;

const HAN_SCRIPT = /\p{Script=Han}/u;

export function needsTaiwaneseLanguageReference(job: ChatbotJob) {
  return [
    job.request,
    job.requestMessage?.content,
    ...job.messages.flatMap((message) => [
      message.content,
      message.referencedMessage?.content,
    ]),
  ].some((value) => value && HAN_SCRIPT.test(value));
}
