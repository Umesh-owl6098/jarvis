import { NextResponse } from 'next/server';
import { omnirouteClient } from '@/core/router/client';
import { resolveRouterMode, ROUTER_MODE_LABEL, isMockMode } from '@/core/router/mode';
import { routerRuntime, resolveRouterStatus, isGenerationAvailable } from '@/core/router/runtime-status';

export const dynamic = 'force-dynamic';

export async function GET() {
  const result = await omnirouteClient.getHealthStatus();
  const mode = resolveRouterMode();
  const runtime = routerRuntime.snapshot();

  // Reachability alone is not health. Merge it with what real generation calls
  // actually returned, so a reachable-but-429 router is never shown as ONLINE.
  const status = resolveRouterStatus(result.reachable, runtime.lastGenerationState);

  return NextResponse.json(
    {
      ...result,
      status,
      generationAvailable: isGenerationAvailable(status),
      lastGenerationState: runtime.lastGenerationState,
      lastGenerationAt: runtime.lastGenerationAt,
      lastGenerationStatus: runtime.lastHttpStatus,
      lastSuccessAt: runtime.lastSuccessAt,
      lastFailureAt: runtime.lastFailureAt,
      lastModel: runtime.lastModel,
      lastProvider: runtime.lastProvider,
      routerMode: mode,
      routerLabel: ROUTER_MODE_LABEL[mode],
      isMock: isMockMode(mode),
    },
    { status: 200 }
  );
}
