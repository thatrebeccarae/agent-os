/**
 * n8n workflow tools for Agent.
 *
 * Gated behind N8N_API_KEY — returns empty array if not configured.
 */

import type { Tool } from '../agent/tools.js';
import {
  isN8nConfigured,
  listWorkflows,
  triggerWebhook,
  getExecution,
} from './client.js';
import { wrapAndDetect } from '../security/content-boundary.js';

export function getN8nTools(): Tool[] {
  if (!isN8nConfigured()) return [];

  return [
    {
      name: 'n8n_list_workflows',
      description:
        'List all n8n workflows with ID, name, and active status.',
      input_schema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const workflows = await listWorkflows();
        if (workflows.length === 0) return 'No workflows found.';

        const active = workflows.filter((w) => w.active).length;
        const lines = workflows.map(
          (w) => `[${w.id}] ${w.active ? 'ACTIVE' : 'INACTIVE'} — ${w.name}`,
        );
        return `${workflows.length} workflow(s) (${active} active):\n\n${lines.join('\n')}`;
      },
    },
    {
      name: 'n8n_trigger_workflow',
      description:
        'Trigger an n8n workflow via its production webhook URL. ' +
        'Pass the workflow ID and optional data payload. ' +
        'The workflow must have a Webhook trigger node to accept this.',
      input_schema: {
        type: 'object',
        properties: {
          workflow_id: {
            type: 'string',
            description: 'Workflow ID to trigger',
          },
          data: {
            type: 'object',
            description: 'Optional JSON data to send as the webhook body',
          },
        },
        required: ['workflow_id'],
      },
      handler: async (input) => {
        const workflowId = input.workflow_id as string;
        const data = input.data as Record<string, unknown> | undefined;

        const result = await triggerWebhook(workflowId, data);
        const summary =
          typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2);

        // Wrap webhook response in content boundary
        const wrappedSummary = wrapAndDetect(summary, `n8n:webhook:${workflowId}`);

        // Truncate long responses
        const maxLen = 2000;
        if (wrappedSummary.length > maxLen) {
          return `Workflow ${workflowId} triggered. Response (truncated):\n${wrappedSummary.slice(0, maxLen)}...`;
        }
        return `Workflow ${workflowId} triggered. Response:\n${wrappedSummary}`;
      },
    },
    {
      name: 'n8n_execution_status',
      description:
        'Get the status of an n8n workflow execution by execution ID. ' +
        'Returns status, start/finish times, and error if any.',
      input_schema: {
        type: 'object',
        properties: {
          execution_id: {
            type: 'string',
            description: 'Execution ID to check',
          },
        },
        required: ['execution_id'],
      },
      handler: async (input) => {
        const executionId = input.execution_id as string;
        const exec = await getExecution(executionId);

        const parts = [
          `Execution: ${exec.id}`,
          `Workflow:  ${exec.workflowId}`,
          `Status:    ${exec.status}`,
          `Finished:  ${exec.finished ? 'yes' : 'no'}`,
          `Started:   ${exec.startedAt}`,
        ];

        if (exec.stoppedAt) parts.push(`Stopped:   ${exec.stoppedAt}`);

        const error = exec.data?.resultData?.error?.message;
        if (error) parts.push(`Error:     ${wrapAndDetect(error, `n8n:execution:${exec.id}`)}`);

        return parts.join('\n');
      },
    },
  ];
}
