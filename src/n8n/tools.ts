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
        'You can pass either a workflow_id OR a name (case-insensitive match). ' +
        'If user says "trigger the morning digest", use name="morning digest". ' +
        'To see available workflows, call n8n_list_workflows first. ' +
        'The workflow must have a Webhook trigger node to accept this.',
      input_schema: {
        type: 'object',
        properties: {
          workflow_id: {
            type: 'string',
            description: 'Workflow ID to trigger (optional if name is provided)',
          },
          name: {
            type: 'string',
            description: 'Workflow name to find and trigger (case-insensitive, optional if workflow_id is provided)',
          },
          data: {
            type: 'object',
            description: 'Optional JSON data to send as the webhook body',
          },
        },
        required: [],
      },
      handler: async (input) => {
        let workflowId = input.workflow_id as string | undefined;
        const data = input.data as Record<string, unknown> | undefined;

        // Name-based lookup if no workflow_id provided
        if (!workflowId) {
          const name = input.name as string | undefined;
          if (!name) {
            return 'Error: provide either workflow_id or name to trigger a workflow.';
          }
          const workflows = await listWorkflows();
          const match = workflows.find(
            (w) => w.name.toLowerCase().includes(name.toLowerCase()),
          );
          if (!match) {
            const available = workflows.map((w) => `  [${w.id}] ${w.name}`).join('\n');
            return `No workflow matching "${name}". Available workflows:\n${available}`;
          }
          workflowId = match.id;
          console.log(`[n8n] Resolved workflow name "${name}" → ID ${workflowId} ("${match.name}")`);
        }

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
