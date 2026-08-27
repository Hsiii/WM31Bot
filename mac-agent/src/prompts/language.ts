import type { AnswerJob } from "../../../src/chatbot/protocol";

type SlangReference = {
  terms: readonly string[];
  explanation: string;
};

const REFERENCES: readonly SlangReference[] = [
  {
    terms: ["暈", "暈船"],
    explanation:
      "暈 or 暈船 can mean catching feelings. 我暈 may instead express dizziness or disbelief.",
  },
  {
    terms: ["揪", "不揪"],
    explanation:
      '揪 means invite or gather people. 不揪 is usually the playful complaint "you didn\'t invite me?", while 不要揪我 means "don\'t invite me".',
  },
  { terms: ["脆"], explanation: "脆 means Threads." },
  { terms: ["活網"], explanation: "活網 means extremely online." },
  {
    terms: ["留友看"],
    explanation: "留友看 means leaving a comment so friends may see the post.",
  },
  { terms: ["被塑膠"], explanation: "被塑膠 means being ignored." },
  { terms: ["雷"], explanation: "雷 can mean a spoiler or something bad." },
  { terms: ["炎上"], explanation: "炎上 means mass backlash." },
  { terms: ["情勒"], explanation: "情勒 means emotional blackmail." },
  {
    terms: ["社恐"],
    explanation: "社恐 is casual shorthand for social anxiety.",
  },
  { terms: ["破防"], explanation: "破防 means emotionally affected." },
  { terms: ["硬控"], explanation: "硬控 means captivating." },
  { terms: ["很解"], explanation: "很解 means a turn-off." },
  { terms: ["包的"], explanation: "包的 means definitely or leave it to me." },
  { terms: ["要確欸"], explanation: '要確欸 means "are you sure?"' },
  { terms: ["蛋雕"], explanation: "蛋雕 means discard." },
  { terms: ["泉"], explanation: "泉 can mean boast or exaggerate." },
  { terms: ["很躁"], explanation: "很躁 means irritating." },
  {
    terms: ["還得是你"],
    explanation:
      '還得是你 means admiringly or resignedly "of course it had to be you".',
  },
  { terms: ["各各"], explanation: "各各 means 各付各的." },
  { terms: ["估咩"], explanation: "估咩 means Google Maps." },
  { terms: ["近更"], explanation: "近更 means 近況更新." },
  { terms: ["傳小"], explanation: "傳小 means 傳統小吃." },
  {
    terms: ["大奶微微"],
    explanation: "大奶微微 means 大杯奶茶微糖微冰.",
  },
  { terms: ["穩單"], explanation: "穩單 means 穩定單身." },
  { terms: ["歡回"], explanation: "歡回 means 歡迎回來." },
  { terms: ["生快"], explanation: "生快 means 生日快樂." },
  { terms: ["與眾分"], explanation: "與眾分 means 與眾人分享." },
  {
    terms: ["這感我付"],
    explanation: "這感我付 means 這段感情感覺只有我在付出.",
  },
  { terms: ["有合嗎"], explanation: "有合嗎 means 有合理嗎." },
  { terms: ["6."], explanation: "6. can mean 六點." },
  { terms: ["觸爛"], explanation: "觸爛 can mean strong agreement." },
  { terms: ["M3"], explanation: 'M3 can mean "你懂我意思吧".' },
  { terms: ["SLDPK"], explanation: "SLDPK can mean extremely funny." },
  { terms: ["YYDS"], explanation: "YYDS means 永遠的神." },
];

function languageContext(job: AnswerJob) {
  return [
    job.request,
    job.requestMessage?.content,
    ...job.messages.flatMap((message) => [
      message.content,
      message.referencedMessage?.content,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .toLocaleLowerCase();
}

export function taiwaneseLanguageReference(job: AnswerJob) {
  const context = languageContext(job);
  const matched = REFERENCES.filter(({ terms }) =>
    terms.some((term) => context.includes(term.toLocaleLowerCase())),
  );
  if (!matched.length) return undefined;

  return `Interpret only the Taiwanese shorthand present in the supplied context:\n${matched
    .map(({ explanation }) => `- ${explanation}`)
    .join(
      "\n",
    )}\nTreat unfamiliar or fast-changing slang as uncertain and search when its meaning materially affects the answer.`;
}
