/**
 * Extraction-only markers for the workspace Typert generator, which recognizes
 * external protocol symbols through ambient declarations. Only the empty Host
 * aggregate maps this file; package builds check the real DSH declarations.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export interface TypertLookup<Host, Wire> {
    readonly host: Host
    readonly wire: Wire
  }

  export interface TypertContext<Wire> {
    readonly wire: Wire
  }

  export interface TypertLookupMap {}
  export interface TypertContextMap {}

  export abstract class TypertRemoteService {
    protected readonly ctx: import('@deepseek-ai/cordis').Context
    protected constructor(
      ctx: import('@deepseek-ai/cordis').Context,
      serviceKey: string,
      options?: { readonly namespace?: string },
    )
  }

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  export function Remote(option: string | { readonly mode: 'stream' }):
  <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void
}
