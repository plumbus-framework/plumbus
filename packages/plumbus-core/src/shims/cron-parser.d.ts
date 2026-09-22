declare module 'cron-parser' {
  export function parseExpression(
    expression: string,
    options?: { currentDate?: Date },
  ): {
    next(): { toDate(): Date };
  };
}
