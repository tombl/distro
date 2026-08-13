export interface GuestSiteOptions {
  hub: string;
  fetch(port: number): (request: Request) => Promise<Response>;
}

export interface GuestSiteHandle {
  close(): void;
}

export function serveGuest(options: GuestSiteOptions): GuestSiteHandle;
