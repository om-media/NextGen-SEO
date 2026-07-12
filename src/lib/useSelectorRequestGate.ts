import { useRef } from "react";

export function createSelectorRequestGate<Scope extends string>() {
  const currentRequests = new Map<Scope, number>();

  return {
    begin(scope: Scope) {
      const nextRequestId = (currentRequests.get(scope) || 0) + 1;
      currentRequests.set(scope, nextRequestId);
      return nextRequestId;
    },
    cancel(scope: Scope) {
      const nextRequestId = (currentRequests.get(scope) || 0) + 1;
      currentRequests.set(scope, nextRequestId);
      return nextRequestId;
    },
    isCurrent(scope: Scope, requestId: number) {
      return currentRequests.get(scope) === requestId;
    },
  };
}

export function useSelectorRequestGate<Scope extends string>() {
  const gateRef = useRef(createSelectorRequestGate<Scope>());
  return gateRef.current;
}
