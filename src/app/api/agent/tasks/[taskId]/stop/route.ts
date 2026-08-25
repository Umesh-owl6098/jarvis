import { NextRequest } from 'next/server';
import { taskRegistry } from '@/core/agent/task-registry';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  if (!taskId || typeof taskId !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Invalid taskId parameter' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const status = taskRegistry.getStatus(taskId);

  if (status === 'not_found') {
    return new Response(
      JSON.stringify({ error: 'Task not found', taskId }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (status !== 'running') {
    return new Response(
      JSON.stringify({
        status: 'already_' + status,
        taskId,
        message: `Task is already ${status}`,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const stopped = taskRegistry.stopTask(taskId);

  if (!stopped) {
    return new Response(
      JSON.stringify({
        error: 'Failed to stop task',
        taskId,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      status: 'stopped',
      taskId,
      stoppedAt: Date.now(),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
