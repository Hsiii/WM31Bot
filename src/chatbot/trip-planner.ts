import { randomUUID } from "node:crypto";

export const KYUSHU_TRIP_GUILD_ID = "1282936453134815275";
export const DEFAULT_KYUSHU_WORKSPACE_URL =
  "https://kyushu.hsichen.dev/api/workspaces/kyushu-2026";

type ScheduleKind =
  | "arrival"
  | "departure"
  | "stay"
  | "place"
  | "food"
  | "transit"
  | "concert"
  | "friend"
  | "open";

type ScheduleItem = {
  id: string;
  time: string;
  title: string;
  subtitle: string;
  kind: ScheduleKind;
  duration?: string;
  detail?: string;
  locked?: boolean;
  candidateId?: string;
  trafficFromPrevious?: Record<string, unknown>;
};

type TripDay = {
  date: string;
  shortDate: string;
  weekday: string;
  city: string;
  summary: string;
  items: ScheduleItem[];
};

type PlanVariant = {
  id: string;
  name: string;
  description: string;
  days: TripDay[];
  stats: Record<string, unknown>;
};

type Candidate = {
  id: string;
  title: string;
  japanese?: string;
  city: string;
  category: string;
  importance: string;
  duration: string;
  best: string;
  transit: string;
  budget: string;
  summary: string;
  sourceUrl?: string;
};

type CustomRule = {
  id: string;
  type: string;
  value: string;
};

type WorkspaceData = {
  customRules: CustomRule[];
  customCandidates?: Candidate[];
  priorityOverrides: Record<string, string>;
  variants: PlanVariant[];
};

type WorkspaceEnvelope = {
  data: WorkspaceData;
  updatedAt: string;
  version: number;
};

export type TripPlanReadInput = {
  planId?: string;
  date?: string;
  query?: string;
};

export type TripPlanEditInput = {
  action: "add_item" | "update_item" | "remove_item" | "update_day";
  planId: string;
  date: string;
  itemId?: string;
  time?: string;
  title?: string;
  subtitle?: string;
  kind?: ScheduleKind;
  duration?: string;
  detail?: string;
  city?: string;
  summary?: string;
};

export type TripPlannerClient = {
  read: (input: TripPlanReadInput) => Promise<Record<string, unknown>>;
  edit?: (input: TripPlanEditInput) => Promise<Record<string, unknown>>;
};

type TripPlannerEnvironment = {
  [key: string]: string | undefined;
  MINISAGO_TRIP_WORKSPACE_URL?: string;
  MINISAGO_TRIP_WORKSPACE_TOKEN?: string;
};

function isWorkspaceEnvelope(value: unknown): value is WorkspaceEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<WorkspaceEnvelope>;
  return (
    Number.isInteger(envelope.version) &&
    typeof envelope.updatedAt === "string" &&
    Boolean(envelope.data) &&
    Array.isArray(envelope.data?.variants)
  );
}

async function responseError(response: Response) {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // The status below is sufficient when the upstream is not JSON.
  }
  return `Trip workspace request failed (${response.status}).`;
}

function findPlan(data: WorkspaceData, planId: string) {
  const normalized = planId.trim().toLocaleLowerCase();
  const plan = data.variants.find(
    (candidate) =>
      candidate.id.toLocaleLowerCase() === normalized ||
      candidate.name.toLocaleLowerCase() === normalized,
  );
  if (!plan) throw new Error(`Trip plan not found: ${planId}`);
  return plan;
}

function findDay(plan: PlanVariant, date: string) {
  const day = plan.days.find((candidate) => candidate.date === date);
  if (!day) throw new Error(`Trip date not found in ${plan.name}: ${date}`);
  return day;
}

function overview(envelope: WorkspaceEnvelope) {
  return {
    status: "complete",
    mode: "overview",
    workspaceVersion: envelope.version,
    updatedAt: envelope.updatedAt,
    shareUrl: "https://kyushu.hsichen.dev",
    plans: envelope.data.variants.map((plan) => ({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      stats: plan.stats,
      days: plan.days.map((day) => ({
        date: day.date,
        shortDate: day.shortDate,
        weekday: day.weekday,
        city: day.city,
        summary: day.summary,
        itemCount: day.items.length,
        itemTitles: day.items.map((item) => item.title),
      })),
    })),
    customRuleCount: envelope.data.customRules.length,
    customCandidateCount: envelope.data.customCandidates?.length ?? 0,
  };
}

function dayDetails(envelope: WorkspaceEnvelope, input: TripPlanReadInput) {
  const plans = input.planId
    ? [findPlan(envelope.data, input.planId)]
    : envelope.data.variants;
  return {
    status: "complete",
    mode: "day",
    workspaceVersion: envelope.version,
    updatedAt: envelope.updatedAt,
    date: input.date,
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      day: findDay(plan, input.date!),
    })),
  };
}

function search(envelope: WorkspaceEnvelope, input: TripPlanReadInput) {
  const needle = input.query!.trim().toLocaleLowerCase();
  const plans = input.planId
    ? [findPlan(envelope.data, input.planId)]
    : envelope.data.variants;
  const schedule = plans.flatMap((plan) =>
    plan.days.flatMap((day) =>
      day.items.flatMap((item) =>
        `${item.title} ${item.subtitle} ${item.detail ?? ""}`
          .toLocaleLowerCase()
          .includes(needle)
          ? [{ planId: plan.id, planName: plan.name, date: day.date, item }]
          : [],
      ),
    ),
  );
  const candidates = (envelope.data.customCandidates ?? []).filter(
    (candidate) =>
      `${candidate.title} ${candidate.japanese ?? ""} ${candidate.city} ${candidate.summary}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  const rules = envelope.data.customRules.filter((rule) =>
    `${rule.type} ${rule.value}`.toLocaleLowerCase().includes(needle),
  );
  return {
    status: "complete",
    mode: "search",
    query: input.query,
    workspaceVersion: envelope.version,
    matches: {
      schedule: schedule.slice(0, 30),
      candidates: candidates.slice(0, 20),
      rules: rules.slice(0, 20),
    },
    truncated:
      schedule.length > 30 || candidates.length > 20 || rules.length > 20,
  };
}

function applyEdit(data: WorkspaceData, input: TripPlanEditInput) {
  const plan = findPlan(data, input.planId);
  const day = findDay(plan, input.date);

  if (input.action === "update_day") {
    if (input.city === undefined && input.summary === undefined) {
      throw new Error("update_day requires city or summary.");
    }
    if (input.city !== undefined) day.city = input.city;
    if (input.summary !== undefined) day.summary = input.summary;
    return { plan, day };
  }

  if (input.action === "add_item") {
    if (!input.time || !input.title || !input.subtitle || !input.kind) {
      throw new Error("add_item requires time, title, subtitle, and kind.");
    }
    const item: ScheduleItem = {
      id: `discord-${randomUUID()}`,
      time: input.time,
      title: input.title,
      subtitle: input.subtitle,
      kind: input.kind,
      ...(input.duration ? { duration: input.duration } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    day.items.push(item);
    return { plan, day, item };
  }

  if (!input.itemId) {
    throw new Error(`${input.action} requires itemId.`);
  }
  const itemIndex = day.items.findIndex((item) => item.id === input.itemId);
  const item = day.items[itemIndex];
  if (!item) throw new Error(`Schedule item not found: ${input.itemId}`);
  if (item.locked) throw new Error("Fixed trip items cannot be edited.");

  if (input.action === "remove_item") {
    day.items.splice(itemIndex, 1);
    return { plan, day, item };
  }

  const updates = {
    time: input.time,
    title: input.title,
    subtitle: input.subtitle,
    kind: input.kind,
    duration: input.duration,
    detail: input.detail,
  };
  if (Object.values(updates).every((value) => value === undefined)) {
    throw new Error("update_item requires at least one changed field.");
  }
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      Object.assign(item, { [key]: value });
    }
  }
  return { plan, day, item };
}

export function tripPlannerAvailableForGuild(guildId?: string) {
  return guildId === KYUSHU_TRIP_GUILD_ID;
}

export function createTripPlannerClient(
  environment: TripPlannerEnvironment = process.env,
  editSessionId = `minisago-${randomUUID()}`,
): TripPlannerClient {
  const url =
    environment.MINISAGO_TRIP_WORKSPACE_URL?.trim() ||
    DEFAULT_KYUSHU_WORKSPACE_URL;
  const token = environment.MINISAGO_TRIP_WORKSPACE_TOKEN?.trim();
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

  const load = async () => {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(await responseError(response));
    const envelope: unknown = await response.json();
    if (!isWorkspaceEnvelope(envelope)) {
      throw new Error("Trip workspace returned an invalid response.");
    }
    return envelope;
  };

  const read = async (input: TripPlanReadInput) => {
    const envelope = await load();
    if (input.query) return search(envelope, input);
    if (input.date) return dayDetails(envelope, input);
    return overview(envelope);
  };

  if (!token) return { read };

  const edit = async (input: TripPlanEditInput) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const envelope = await load();
      const changed = applyEdit(envelope.data, input);
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: envelope.data,
          editLabel: "MiniSago · Discord",
          editSessionId,
          version: envelope.version,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 409 && attempt === 0) continue;
      if (!response.ok) throw new Error(await responseError(response));
      const saved: unknown = await response.json();
      if (!isWorkspaceEnvelope(saved)) {
        throw new Error("Trip workspace returned an invalid save response.");
      }
      return {
        status: "complete",
        action: input.action,
        plan: { id: changed.plan.id, name: changed.plan.name },
        date: changed.day.date,
        ...(changed.item
          ? { item: { id: changed.item.id, title: changed.item.title } }
          : {}),
        workspaceVersion: saved.version,
        updatedAt: saved.updatedAt,
        shareUrl: "https://kyushu.hsichen.dev",
      };
    }
    throw new Error("Trip workspace changed repeatedly; try again.");
  };

  return { read, edit };
}
