import { authFetch } from "../lib/authFetch";

export interface Annotation {
  id: string;
  userId: string;
  siteUrl: string | null;
  date: string;
  title: string;
  description: string;
  type: 'user' | 'system';
  createdAt: string;
}

const SYSTEM_ANNOTATIONS: Annotation[] = [
  { id: 'sys-2026-03-core', userId: 'system', siteUrl: null, date: '2026-03-27', title: 'March 2026 Core Update', description: 'Google March 2026 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2026-03-spam', userId: 'system', siteUrl: null, date: '2026-03-24', title: 'March 2026 Spam Update', description: 'Google March 2026 spam update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2026-02-discover', userId: 'system', siteUrl: null, date: '2026-02-05', title: 'February 2026 Discover Update', description: 'Google February 2026 Discover update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-12-core', userId: 'system', siteUrl: null, date: '2025-12-11', title: 'December 2025 Core Update', description: 'Google December 2025 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-08-spam', userId: 'system', siteUrl: null, date: '2025-08-26', title: 'August 2025 Spam Update', description: 'Google August 2025 spam update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-06-core', userId: 'system', siteUrl: null, date: '2025-06-30', title: 'June 2025 Core Update', description: 'Google June 2025 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2025-03-core', userId: 'system', siteUrl: null, date: '2025-03-13', title: 'March 2025 Core Update', description: 'Google March 2025 core update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2024-12-spam', userId: 'system', siteUrl: null, date: '2024-12-19', title: 'December 2024 Spam Update', description: 'Google December 2024 spam update rollout began.', type: 'system', createdAt: '' },
  { id: 'sys-2024-12-core', userId: 'system', siteUrl: null, date: '2024-12-12', title: 'December 2024 Core Update', description: 'Google December 2024 core update rollout began.', type: 'system', createdAt: '' },
];

export class AnnotationsService {
  static async getAnnotations(userId: string, siteUrl?: string): Promise<Annotation[]> {
    const url = new URL(`/api/annotations/${userId}`, window.location.origin);
    if (siteUrl) {
      url.searchParams.append('siteUrl', siteUrl);
    }
    const response = await authFetch(url.toString());
    if (!response.ok) {
      throw new Error('Failed to fetch annotations');
    }
    const userAnnotations = await response.json();
    return [...userAnnotations, ...SYSTEM_ANNOTATIONS].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  static async addAnnotation(userId: string, annotation: Partial<Annotation>): Promise<void> {
    const response = await authFetch(`/api/annotations/${userId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(annotation),
    });
    if (!response.ok) {
      throw new Error('Failed to add annotation');
    }
  }

  static async deleteAnnotation(userId: string, annotationId: string): Promise<void> {
    const response = await authFetch(`/api/annotations/${userId}/${annotationId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Failed to delete annotation');
    }
  }
}
