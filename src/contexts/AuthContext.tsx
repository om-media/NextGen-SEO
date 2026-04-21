import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, GoogleAuthProvider, signInWithPopup, signOut as firebaseSignOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, linkWithPopup } from 'firebase/auth';
import { auth } from '../firebase';

export interface UserProfile {
  email: string;
  tier: 'free' | 'pro' | 'enterprise';
  unlockedSites: string[];
  bingApiKey?: string;
}

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  loading: boolean;
  accessToken: string | null;
  signInWithGoogle: () => Promise<void>;
  registerWithEmail: (email: string, pass: string) => Promise<void>;
  loginWithEmail: (email: string, pass: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearAccessToken: () => void;
  unlockSite: (siteUrl: string) => Promise<void>;
  setTier: (tier: 'free' | 'pro' | 'enterprise') => Promise<void>;
  setBingApiKey: (key: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem('gsc_access_token'));
  const [authError, setAuthError] = useState<Error | null>(null);

  if (authError) {
    throw authError;
  }

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (firebaseUser) => {
      setUser(firebaseUser);
      if (!firebaseUser) {
        setUserProfile(null);
        setLoading(false);
        return;
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) return;

    const fetchOrInitializeProfile = async () => {
      try {
        const res = await fetch(`/api/users/${user.uid}`);
        if (res.ok) {
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.indexOf("application/json") !== -1) {
            const data = await res.json();
            setUserProfile(data);
          } else {
            throw new Error("API returned non-JSON html (likely a proxy or Vite fallback).");
          }
        } else if (res.status === 404) {
          // Create new user
          const newUser = {
            id: user.uid,
            email: user.email || '',
            tier: 'free',
            unlockedSites: [],
            createdAt: new Date().toISOString()
          };
          const createRes = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newUser)
          });
          if (createRes.ok) {
            setUserProfile({
              email: newUser.email,
              tier: newUser.tier as any,
              unlockedSites: newUser.unlockedSites
            });
          } else {
            throw new Error('Failed to create user profile');
          }
        } else {
          throw new Error('Failed to fetch user profile');
        }
      } catch (error: any) {
        if (!error.message?.includes('non-JSON')) {
          console.error("Error fetching/creating user profile:", error);
        }
        // Fallback to memory
        setUserProfile({
          email: user.email || '',
          tier: 'free',
          unlockedSites: []
        });
      } finally {
        setLoading(false);
      }
    };

    fetchOrInitializeProfile();
  }, [user]);

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/webmasters.readonly');
    provider.addScope('https://www.googleapis.com/auth/analytics.readonly');
    try {
      if (auth.currentUser && !auth.currentUser.providerData.some(p => p.providerId === 'google.com')) {
        const result = await linkWithPopup(auth.currentUser, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          setAccessToken(credential.accessToken);
          localStorage.setItem('gsc_access_token', credential.accessToken);
        }
      } else {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          setAccessToken(credential.accessToken);
          localStorage.setItem('gsc_access_token', credential.accessToken);
        }
      }
    } catch (error: any) {
      if (error.code === 'auth/cancelled-popup-request' || error.code === 'auth/popup-closed-by-user') {
         // Silently ignore popup closure or notify user via toast (no crash dump)
         return;
      }
      console.error("Error signing in with Google:", error);
      if (error.code === 'auth/credential-already-in-use') {
        // If the google account is already linked to another user, just sign in with it
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          setAccessToken(credential.accessToken);
          localStorage.setItem('gsc_access_token', credential.accessToken);
        }
      }
    }
  };

  const registerWithEmail = async (email: string, pass: string) => {
    await createUserWithEmailAndPassword(auth, email, pass);
  };

  const loginWithEmail = async (email: string, pass: string) => {
    await signInWithEmailAndPassword(auth, email, pass);
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
    setAccessToken(null);
    localStorage.removeItem('gsc_access_token');
  };

  const clearAccessToken = () => {
    setAccessToken(null);
    localStorage.removeItem('gsc_access_token');
  };

  const unlockSite = async (siteUrl: string) => {
    if (!user || !userProfile) return;
    
    if (userProfile.tier === 'enterprise') return; // Enterprise users have all sites unlocked

    // Check limits
    const limit = userProfile.tier === 'free' ? 1 : userProfile.tier === 'pro' ? 3 : Infinity;
    if (userProfile.unlockedSites.length >= limit) {
      throw new Error(`You have reached the maximum number of sites for your ${userProfile.tier} tier.`);
    }

    if (userProfile.unlockedSites.includes(siteUrl)) {
      return; // Already unlocked
    }

    try {
      const res = await fetch(`/api/users/${user.uid}/unlock`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteUrl })
      });
      
      if (!res.ok) {
        throw new Error('Failed to unlock site');
      }
      
      const data = await res.json();
      
      setUserProfile(prev => prev ? {
        ...prev,
        unlockedSites: data.unlockedSites
      } : null);
    } catch (error: any) {
      console.error("Failed to unlock site:", error);
      throw new Error("Failed to unlock property. Please try again.");
    }
  };

  const setTier = async (tier: 'free' | 'pro' | 'enterprise') => {
    if (!user) return;
    try {
      const res = await fetch(`/api/users/${user.uid}/tier`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier })
      });
      if (res.ok) {
        const data = await res.json();
        setUserProfile(prev => prev ? { ...prev, tier, unlockedSites: data.unlockedSites || prev.unlockedSites } : null);
      }
    } catch (error) {
      console.error("Failed to update tier:", error);
    }
  };

  const setBingApiKey = async (bingApiKey: string) => {
    if (!user) return;
    try {
      const res = await fetch(`/api/users/${user.uid}/bing-key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bingApiKey })
      });
      if (res.ok) {
        setUserProfile(prev => prev ? { ...prev, bingApiKey } : null);
      }
    } catch (error) {
      console.error("Failed to update Bing API key:", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, userProfile, loading, accessToken, signInWithGoogle, registerWithEmail, loginWithEmail, signOut, clearAccessToken, unlockSite, setTier, setBingApiKey }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
