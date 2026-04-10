import { collection, addDoc, getDocs, query, where, serverTimestamp, deleteDoc, doc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';

export interface SavedFilter {
  id?: string;
  name: string;
  projectId: string; // We'll use siteUrl for now
  ownerId: string;
  configuration: string; // JSON string
  createdAt: any;
}

export const saveFilter = async (filter: Omit<SavedFilter, 'id' | 'createdAt' | 'ownerId'>) => {
  const path = 'filters';
  try {
    if (!auth.currentUser) throw new Error("Not authenticated");
    const docRef = await addDoc(collection(db, path), {
      ...filter,
      ownerId: auth.currentUser.uid,
      createdAt: serverTimestamp()
    });
    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export const getFilters = async (projectId: string) => {
  const path = 'filters';
  try {
    if (!auth.currentUser) throw new Error("Not authenticated");
    const q = query(
      collection(db, path), 
      where('ownerId', '==', auth.currentUser.uid),
      where('projectId', '==', projectId)
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SavedFilter));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export const deleteFilter = async (filterId: string) => {
  const path = `filters/${filterId}`;
  try {
    if (!auth.currentUser) throw new Error("Not authenticated");
    await deleteDoc(doc(db, 'filters', filterId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
