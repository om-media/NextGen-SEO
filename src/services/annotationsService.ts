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
  { id: 'sys-1', userId: 'system', siteUrl: null, date: '2024-03-05', title: 'March 2024 Core Update', description: 'Google March 2024 core update', type: 'system', createdAt: '' },
  { id: 'sys-2', userId: 'system', siteUrl: null, date: '2024-05-05', title: 'Site Reputation Abuse', description: 'Enforcement of site reputation abuse policy', type: 'system', createdAt: '' },
  { id: 'sys-3', userId: 'system', siteUrl: null, date: '2024-06-20', title: 'June 2024 Spam Update', description: 'Google June 2024 spam update', type: 'system', createdAt: '' },
  { id: 'sys-4', userId: 'system', siteUrl: null, date: '2024-08-15', title: 'August 2024 Core Update', description: 'Google August 2024 core update', type: 'system', createdAt: '' },
  { id: 'sys-5', userId: 'system', siteUrl: null, date: '2024-11-11', title: 'November 2024 Core Update', description: 'Google November 2024 core update', type: 'system', createdAt: '' },
  { id: 'sys-6', userId: 'system', siteUrl: null, date: '2025-02-18', title: 'February 2025 Core Update', description: 'Google February 2025 core update', type: 'system', createdAt: '' },
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
