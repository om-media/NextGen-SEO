import React, { createContext, useContext, useEffect, useState } from 'react';
import { authFetch } from '../lib/authFetch';
import type { PlanTier } from '../../shared/plans';

export interface AppUser {
  uid: string;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
}

export interface UserProfile {
  id?: string;
  email: string;
  name?: string | null;
  company?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  googleConnected?: boolean;
  bingConnected?: boolean;
  tier: PlanTier;
  unlockedSites: string[];
  knownSites?: string[];
  onboardingCompleted?: boolean;
  activatedSiteUrl?: string | null;
  activatedGa4PropertyId?: string | null;
  activatedGa4DisplayName?: string | null;
}

type UserProfileUpdate = {
  name: string;
  company: string;
  avatarUrl: string;
  bio: string;
};

interface AuthContextType {
  user: AppUser | null;
  userProfile: UserProfile | null;
  loading: boolean;
  registerWithEmail: (email: string, pass: string) => Promise<void>;
  loginWithEmail: (email: string, pass: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  connectGoogleServices: () => Promise<string | undefined>;
  disconnectGoogleServices: () => Promise<void>;
  unlockSite: (siteUrl: string) => Promise<void>;
  setBingApiKey: (key: string) => Promise<void>;
  completeOnboarding: (activatedSiteUrl: string, activatedGa4Property?: { siteUrl: string; displayName: string } | null) => Promise<void>;
  updateDefaultSite: (activatedSiteUrl: string) => Promise<void>;
  updateDefaultGa4Property: (activatedGa4PropertyId: string, activatedGa4DisplayName?: string | null, siteUrl?: string | null) => Promise<void>;
  updateUserProfile: (profile: UserProfileUpdate) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);
const SIGNED_OUT_NOTICE_SESSION_KEY = 'signed_out_notice';

type SessionPayload = {
  user: AppUser;
  profile: UserProfile;
};

function buildAppUser(profile: UserProfile): AppUser {
  return {
    uid: profile.id || '',
    email: profile.email,
    displayName: profile.name || null,
    photoURL: profile.avatarUrl || null,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const applySession = (payload: SessionPayload | null) => {
    if (!payload) {
      setUser(null);
      setUserProfile(null);
      return;
    }

    setUser(payload.user);
    setUserProfile(payload.profile);
  };

  const loadSession = async () => {
    const response = await authFetch('/api/auth/session');
    if (response.status === 401) {
      applySession(null);
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.user || !data?.profile) {
      throw new Error(data?.error || 'Failed to load session');
    }

    applySession(data as SessionPayload);
    return data as SessionPayload;
  };

  useEffect(() => {
    const bootstrapSession = async () => {
      try {
        await loadSession();
      } catch (error) {
        console.error('Failed to bootstrap session:', error);
        applySession(null);
      } finally {
        setLoading(false);
      }
    };

    void bootstrapSession();
  }, []);

  const readJsonError = async (response: Response, fallbackMessage: string) => {
    const data = await response.json().catch(() => null);
    const error = new Error(data?.error || fallbackMessage) as Error & { code?: string };
    if (data?.code) {
      error.code = data.code;
    }
    throw error;
  };

  const registerWithEmail = async (email: string, pass: string) => {
    const response = await authFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to create account');
    }

    const payload = await response.json() as SessionPayload;
    applySession(payload);
  };

  const loginWithEmail = async (email: string, pass: string) => {
    const response = await authFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass }),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to sign in');
    }

    const payload = await response.json() as SessionPayload;
    applySession(payload);
  };

  const signInWithGoogle = async () => {
    const response = await authFetch('/api/auth/google/start');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Google sign-in route is not available yet. Restart the dev server and try again.');
    }

    const data = await response.json();
    if (!response.ok || !data.authUrl) {
      throw new Error(data.error || 'Failed to start Google sign-in');
    }

    const popup = window.open(data.authUrl, 'nextgen-google-auth', 'width=520,height=720');
    if (!popup) {
      throw new Error('Popup blocked. Please allow popups and try again.');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          window.removeEventListener('message', handleMessage);
          reject(new Error('Google sign-in timed out.'));
        }
      }, 120000);

      const pollId = window.setInterval(() => {
        if (popup.closed && !settled) {
          settled = true;
          window.clearTimeout(timeoutId);
          window.clearInterval(pollId);
          window.removeEventListener('message', handleMessage);
          reject(new Error('Google sign-in was cancelled.'));
        }
      }, 500);

      const handleMessage = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) {
          return;
        }

        if (event.data?.source !== 'nextgen-seo-google-oauth') {
          return;
        }

        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        window.clearInterval(pollId);
        window.removeEventListener('message', handleMessage);

        if (!event.data.success) {
          reject(new Error(event.data.message || 'Google sign-in failed.'));
          return;
        }

        try {
          await loadSession();
          resolve();
        } catch (error: any) {
          reject(error);
        }
      };

      window.addEventListener('message', handleMessage);
    });
  };

  const signOut = async () => {
    await authFetch('/api/auth/logout', { method: 'POST' });
    applySession(null);
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(SIGNED_OUT_NOTICE_SESSION_KEY, 'true');
    }
  };

  const connectGoogleServices = async () => {
    const response = await authFetch('/api/google/oauth/start');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Google connect route is not available yet. Restart the dev server and try again.');
    }

    const data = await response.json();
    if (!response.ok || !data.authUrl) {
      throw new Error(data.error || 'Failed to start Google connection');
    }

    const popup = window.open(data.authUrl, 'nextgen-google-oauth', 'width=520,height=720');
    if (!popup) {
      throw new Error('Popup blocked. Please allow popups and try again.');
    }

    return new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          window.removeEventListener('message', handleMessage);
          reject(new Error('Google connection timed out.'));
        }
      }, 120000);

      const pollId = window.setInterval(() => {
        if (popup.closed && !settled) {
          settled = true;
          window.clearTimeout(timeoutId);
          window.clearInterval(pollId);
          window.removeEventListener('message', handleMessage);
          reject(new Error('Google connection was cancelled.'));
        }
      }, 500);

      const handleMessage = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) {
          return;
        }

        if (event.data?.source !== 'nextgen-seo-google-oauth') {
          return;
        }

        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeoutId);
        window.clearInterval(pollId);
        window.removeEventListener('message', handleMessage);

        if (!event.data.success) {
          reject(new Error(event.data.message || 'Google connection failed.'));
          return;
        }

        try {
          await loadSession();
          resolve(typeof event.data.message === 'string' ? event.data.message : undefined);
        } catch (error: any) {
          reject(error);
        }
      };

      window.addEventListener('message', handleMessage);
    });
  };

  const disconnectGoogleServices = async () => {
    const response = await authFetch('/api/google/connection', {
      method: 'DELETE',
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to disconnect Google data');
    }

    setUserProfile((prev) => prev ? {
      ...prev,
      googleConnected: false,
    } : prev);
  };

  const unlockSite = async (siteUrl: string) => {
    if (!user || !userProfile) return;

    if (userProfile.unlockedSites.includes(siteUrl)) {
      return;
    }

    const response = await authFetch(`/api/users/${user.uid}/unlock`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteUrl }),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to unlock site');
    }

    const data = await response.json();
    setUserProfile((prev) => prev ? { ...prev, unlockedSites: data.unlockedSites } : prev);
  };

  const setBingApiKey = async (bingApiKey: string) => {
    if (!user) return;

    const response = await authFetch(`/api/users/${user.uid}/bing-key`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bingApiKey }),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to update Bing API key');
    }

    setUserProfile((prev) => prev ? { ...prev, bingConnected: Boolean(bingApiKey.trim()) } : prev);
  };

  const completeOnboarding = async (
    activatedSiteUrl: string,
    activatedGa4Property?: { siteUrl: string; displayName: string } | null,
  ) => {
    if (!user) return;

    const response = await authFetch(`/api/users/${user.uid}/onboarding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        onboardingCompleted: true,
        activatedSiteUrl,
        activatedGa4PropertyId: activatedGa4Property?.siteUrl || null,
        activatedGa4DisplayName: activatedGa4Property?.displayName || null,
      }),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to complete onboarding');
    }

    await loadSession();
  };

  const updateDefaultSite = async (activatedSiteUrl: string) => {
    if (!user) return;

    const response = await authFetch(`/api/users/${user.uid}/default-site`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activatedSiteUrl }),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to update default site');
    }

    setUserProfile((prev) => prev ? { ...prev, activatedSiteUrl } : prev);
  };

  const updateDefaultGa4Property = async (activatedGa4PropertyId: string, activatedGa4DisplayName?: string | null, siteUrl?: string | null) => {
    if (!user) return;

    const response = await authFetch(`/api/users/${user.uid}/default-ga4-property`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activatedGa4PropertyId, activatedGa4DisplayName: activatedGa4DisplayName || null, siteUrl: siteUrl || null }),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to update default GA4 property');
    }

    setUserProfile((prev) => prev ? {
      ...prev,
      activatedGa4PropertyId,
      activatedGa4DisplayName: activatedGa4DisplayName || null,
    } : prev);
  };

  const updateUserProfile = async (profile: UserProfileUpdate) => {
    if (!user) return;

    const normalizedProfile = {
      name: profile.name.trim(),
      company: profile.company.trim(),
      avatarUrl: profile.avatarUrl.trim(),
      bio: profile.bio.trim(),
    };

    const response = await authFetch(`/api/users/${user.uid}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizedProfile),
    });

    if (!response.ok) {
      await readJsonError(response, 'Failed to update profile');
    }

    setUser((prev) => prev ? {
      ...prev,
      displayName: normalizedProfile.name || null,
      photoURL: normalizedProfile.avatarUrl || null,
    } : prev);

    setUserProfile((prev) => prev ? {
      ...prev,
      ...normalizedProfile,
    } : prev);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        userProfile,
        loading,
        registerWithEmail,
        loginWithEmail,
        signInWithGoogle,
        signOut,
        connectGoogleServices,
        disconnectGoogleServices,
        unlockSite,
        setBingApiKey,
        completeOnboarding,
        updateDefaultSite,
        updateDefaultGa4Property,
        updateUserProfile,
      }}
    >
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
