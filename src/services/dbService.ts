import { authFetch } from '../lib/authFetch';

export interface SavedFilter {
  id?: string;
  name: string;
  projectId: string; // We'll use siteUrl for now
  configuration: string; // JSON string
  createdAt: any;
}

export const saveFilter = async (filter: Omit<SavedFilter, 'id' | 'createdAt'>) => {
  try {
    const id = crypto.randomUUID();
    const newFilter = {
      ...filter,
      id,
      createdAt: new Date().toISOString()
    };
    
    const res = await authFetch('/api/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newFilter)
    });
    if (!res.ok) throw new Error('Failed to save filter');
    
    return id;
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export const getFilters = async (projectId: string) => {
  try {
    const res = await authFetch(`/api/filters?projectId=${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error('Failed to fetch filters');
    
    const filters = await res.json();
    return filters.filter((f: any) => f.projectId === projectId);
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export const deleteFilter = async (filterId: string) => {
  try {
    const res = await authFetch(`/api/filters/${filterId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete filter');
  } catch (error) {
    console.error(error);
    throw error;
  }
}
