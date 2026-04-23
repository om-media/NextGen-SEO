import { useEffect, useState } from "react";
import { authFetch } from "@/src/lib/authFetch";

type UseRankTrackerKeywordsOptions = {
  dimension: "query" | "page" | "country";
  hideTrackerButton: boolean;
  siteUrl: string;
};

function getDefaultTargetDomain(siteUrl: string) {
  return siteUrl.replace(/^https?:\/\//, "").replace(/^sc-domain:/, "").split("/")[0];
}

export function useRankTrackerKeywords({
  dimension,
  hideTrackerButton,
  siteUrl,
}: UseRankTrackerKeywordsOptions) {
  const [addedKeywords, setAddedKeywords] = useState<Set<string>>(new Set());
  const [addingKeywords, setAddingKeywords] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!siteUrl || hideTrackerButton || dimension !== "query") {
      setAddedKeywords(new Set());
      return;
    }

    authFetch(`/api/rank-tracking/keywords?siteUrl=${encodeURIComponent(siteUrl)}`)
      .then((response) => response.json())
      .then((keywords) => {
        if (Array.isArray(keywords)) {
          setAddedKeywords(new Set(keywords.map((keyword) => keyword.keyword)));
        }
      })
      .catch(console.error);
  }, [dimension, hideTrackerButton, siteUrl]);

  const addKeywordToTracker = async (keyword: string, initialPosition: number) => {
    try {
      setAddingKeywords((previous) => new Set(previous).add(keyword));

      const response = await authFetch("/api/rank-tracking/keywords", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteUrl,
          keywords: [keyword],
          location: "US",
          device: "desktop",
          targetDomain: getDefaultTargetDomain(siteUrl),
          initialPositions: {
            [keyword]: initialPosition,
          },
        }),
      });

      if (response.ok) {
        setAddedKeywords((previous) => new Set(previous).add(keyword));
      }
    } catch (error) {
      console.error("Failed to add keyword to rank tracker:", error);
    } finally {
      setAddingKeywords((previous) => {
        const next = new Set(previous);
        next.delete(keyword);
        return next;
      });
    }
  };

  return {
    addKeywordToTracker,
    addedKeywords,
    addingKeywords,
  };
}
