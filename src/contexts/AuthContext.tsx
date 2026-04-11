import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, GoogleAuthProvider, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../firebase';

export interface UserProfile {
  email: string;
  tier: 'free' | 'pro' | 'enterprise';
  unlockedSites: string[];
}

interface AuthContextType {
  user: User | null;
  userProfile: UserProfile | null;
  loading: boolean;
  accessToken: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  clearAccessToken: () => void;
  unlockSite: (siteUrl: string) => Promise<void>;
  setTier: (tier: 'free' | 'pro' | 'enterprise') => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessToken, setAccessToken] = useState<string | null>(() => sessionStorage.getItem('gsc_access_token'));
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
          const data = await res.json();
          setUserProfile(data);
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
      } catch (error) {
        console.error("Error fetching/creating user profile:", error);
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
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setAccessToken(credential.accessToken);
        sessionStorage.setItem('gsc_access_token', credential.accessToken);
      }
    } catch (error) {
      console.error("Error signing in with Google:", error);
    }
  };

  const signOut = async () => {
    await firebaseSignOut(auth);
    setAccessToken(null);
    sessionStorage.removeItem('gsc_access_token');
  };

  const clearAccessToken = () => {
    setAccessToken(null);
    sessionStorage.removeItem('gsc_access_token');
  };

  const unlockSite = async (siteUrl: string) => {
    if (!user || !userProfile) return;
    
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
        setUserProfile(prev => prev ? { ...prev, tier } : null);
      }
    } catch (error) {
      console.error("Failed to update tier:", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, userProfile, loading, accessToken, signInWithGoogle, signOut, clearAccessToken, unlockSite, setTier }}>
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
