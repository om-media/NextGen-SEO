export type VisualSemanticsRequestScope = "workspace" | "evidence";
export type VisualSemanticsRequestTicket = { requestId: number; selectionKey: string };

type Snapshot = VisualSemanticsRequestTicket;

export function createVisualSemanticsRequestFence() {
  const current = new Map<VisualSemanticsRequestScope, Snapshot>();
  const cancel = (scope: VisualSemanticsRequestScope) => {
    const value = current.get(scope);
    current.set(scope, {
      requestId: (value?.requestId || 0) + 1,
      selectionKey: value?.selectionKey || "",
    });
  };

  return {
    begin(scope: VisualSemanticsRequestScope, selectionKey: string): VisualSemanticsRequestTicket {
      const ticket = {
        requestId: (current.get(scope)?.requestId || 0) + 1,
        selectionKey,
      };
      current.set(scope, ticket);
      return ticket;
    },
    cancel,
    cancelAll() {
      cancel("workspace");
      cancel("evidence");
    },
    isCurrent(
      scope: VisualSemanticsRequestScope,
      ticket: VisualSemanticsRequestTicket,
      selectionKey = ticket.selectionKey,
    ) {
      const value = current.get(scope);
      return value?.requestId === ticket.requestId && value.selectionKey === selectionKey;
    },
  };
}

export const getVisualSemanticsWorkspaceKey = (input: {
  activeView: string;
  offset: number;
  search: string;
  siteUrl: string;
}) => JSON.stringify([input.siteUrl, input.activeView, input.search, input.offset]);

export const getVisualSemanticsEvidenceKey = (siteUrl: string, pageKey: string) =>
  JSON.stringify([siteUrl, pageKey]);
