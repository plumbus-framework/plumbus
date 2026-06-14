declare module 'redis' {
  export function createClient(opts: {
    url?: string;
    socket?: { host: string; port: number };
    password?: string;
  }): {
    connect(): Promise<void>;
    lPush(key: string, ...values: string[]): Promise<number>;
    rPopLPush(source: string, dest: string): Promise<string | null>;
    lRem(key: string, count: number, value: string): Promise<number>;
    lRange(key: string, start: number, stop: number): Promise<string[]>;
    lLen?(key: string): Promise<number>;
    zAdd?(key: string, members: { score: number; value: string }[]): Promise<number>;
    zRangeByScore?(
      key: string,
      min: number | string,
      max: number | string,
      options?: { LIMIT?: { offset: number; count: number } },
    ): Promise<string[]>;
    zRem?(key: string, member: string): Promise<number>;
    ping?(): Promise<string>;
    eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    quit(): Promise<unknown>;
  };
}
