const clerkIssuer = process.env.CLERK_FRONTEND_API_URL;

if (!clerkIssuer) {
  throw new Error("CLERK_FRONTEND_API_URL is not set.");
}

const authConfig = {
  providers: [
    {
      domain: clerkIssuer,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
