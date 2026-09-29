/** What an OAuth callback error code (`/login?error=…`) means for the person signing in. */
export function ssoErrorMessage(code: string) {
  switch (code) {
    case "signup_disabled":
    case "unable_to_create_user":
      return "There is no account for this email here, and this sign-in method does not create new ones. Ask an admin to invite you.";
    case "account_not_linked":
      return "An account with this email exists but is not linked to this sign-in method yet. Sign in with your password, then link it on your Account page.";
    case "email_not_found":
      return "The provider did not share an email address. Make one visible (or primary and verified) in your account there and try again.";
    case "email_not_verified":
      return "The provider says this email is not verified. Verify it there and try again.";
    case "email_does_not_match":
      return "That account uses a different email address.";
    case "account_already_linked_to_different_user":
      return "That account is already linked to another user.";
    case "state_mismatch":
    case "state_not_found":
    case "please_restart_the_process":
      return "The sign-in took too long or was opened in another browser. Please try again.";
    case "oauth_provider_not_found":
      return "This sign-in method is no longer available.";
    default:
      return "Could not sign in with that provider. Please try again.";
  }
}
