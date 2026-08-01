import type { ChatbotJob } from "../../../lib/chatbot/protocol";
import {
  ANSWER_OUTPUT_SCHEMA,
  buildAnswerPrompt,
  MAC_FILE_ANSWER_OUTPUT_SCHEMA,
} from "./answer";
import {
  buildExecutionRoutePrompt,
  EXECUTION_ROUTE_OUTPUT_SCHEMA,
} from "./execution-route";
import {
  buildSocialActionPrompt,
  SOCIAL_ACTION_OUTPUT_SCHEMA,
} from "./social-action";

export {
  ANSWER_INSTRUCTIONS,
  ANSWER_OUTPUT_SCHEMA,
  MAC_FILE_ANSWER_OUTPUT_SCHEMA,
  PROMPT_VERSION,
} from "./answer";
export { EXECUTION_ROUTE_OUTPUT_SCHEMA } from "./execution-route";
export { SOCIAL_ACTION_OUTPUT_SCHEMA } from "./social-action";

export function buildCodexPrompt(
  job: ChatbotJob,
  attachmentText: string[],
  ignoredAttachments: string[],
  developerPolicy?: string,
  macFileRoots: string[] = [],
) {
  if (job.purpose === "execution_route") {
    return buildExecutionRoutePrompt(job);
  }
  if (job.purpose === "social_action") return buildSocialActionPrompt(job);
  return buildAnswerPrompt(
    job,
    attachmentText,
    ignoredAttachments,
    developerPolicy,
    macFileRoots,
  );
}

export function outputSchemaForJob(job: ChatbotJob) {
  if (job.purpose === "execution_route") return EXECUTION_ROUTE_OUTPUT_SCHEMA;
  if (job.purpose === "social_action") return SOCIAL_ACTION_OUTPUT_SCHEMA;
  if (job.purpose === "answer") {
    return job.executionTarget === "mac"
      ? MAC_FILE_ANSWER_OUTPUT_SCHEMA
      : ANSWER_OUTPUT_SCHEMA;
  }
  return undefined;
}
