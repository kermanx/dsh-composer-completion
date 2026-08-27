/** Browser plugin mounting its own Remote descriptors and composer overlay. */
import type { Context } from '@deepseek-ai/cordis';
export declare const inject: string[];
/** Mount the package-local Remote contribution before starting its namespace consumer. */
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map