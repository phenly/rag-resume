export async function retry<T>(call: () => Promise<T>, pause: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); } catch (error) {
      const e = error as { status?: number; message?: string };
      if (attempt >= 2 || !(e.status === 429 || (e.status !== undefined && e.status >= 500) || /overloaded/i.test(e.message ?? ''))) throw error;
      await pause(250 * 2 ** attempt);
    }
  }
}
