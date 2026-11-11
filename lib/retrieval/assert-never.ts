export function assertNever(value: never): never {
  void value;
  throw new Error('Unexpected RAG resolution');
}
