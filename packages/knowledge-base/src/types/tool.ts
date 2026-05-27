export interface KnowledgeToolDefinition<Args = unknown, Result = unknown> {
  name: string;
  description?: string;
  inputSchema: unknown;
  handler: (args: Args) => Promise<Result>;
}

export type ToolDefinition<Args = unknown, Result = unknown> = KnowledgeToolDefinition<
  Args,
  Result
>;
