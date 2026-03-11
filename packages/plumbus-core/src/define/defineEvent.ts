import { z } from "zod";
import type { EventDefinition } from "../types/event.js";

interface DefineEventInput<TPayload extends z.ZodTypeAny> {
  name: string;
  description?: string;
  domain?: string;
  version?: string;
  tags?: string[];

  payload: TPayload;
}

export function defineEvent<TPayload extends z.ZodTypeAny>(
  config: DefineEventInput<TPayload>,
): EventDefinition<TPayload> {
  if (!config.name) {
    throw new Error("Event name is required");
  }
  if (!(config.payload instanceof z.ZodType)) {
    throw new Error(`Event "${config.name}": payload must be a Zod schema`);
  }

  return Object.freeze({ ...config });
}
