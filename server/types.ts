import type { Request } from 'express';

export type AuthedRequest = Request & {
  authUser?: {
    uid: string;
  };
};
