# Google OAuth Integration with AWS Cognito

**Version:** 1.0.0  
**Date:** December 2025  
**Purpose:** Specification for implementing Google Sign-In on the client and federating it with AWS Cognito

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [AWS Cognito Configuration](#aws-cognito-configuration)
4. [Google Cloud Console Setup](#google-cloud-console-setup)
5. [Client-Side Implementation](#client-side-implementation)
6. [Authentication Flow](#authentication-flow)
7. [Backend Integration](#backend-integration)
8. [Error Handling](#error-handling)
9. [Testing](#testing)
10. [Security Considerations](#security-considerations)

---

## Overview

This specification describes how to implement Google Sign-In on the client application and federate it with AWS Cognito User Pool. When users sign in with Google, Cognito will:

1. Authenticate the user with Google
2. Create a federated identity in Cognito (if it doesn't exist)
3. Return Cognito JWT tokens (IdToken, AccessToken, RefreshToken)
4. Trigger the PostConfirmation Lambda to create the user record in DynamoDB

**Key Benefits:**
- Users can sign in with their Google account (no password required)
- Unified authentication system (Google and email/password use the same Cognito tokens)
- Automatic account creation via PostConfirmation trigger
- Seamless integration with existing API endpoints

---

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **Google Cloud Project** with OAuth 2.0 credentials
3. **Client Application** (web, mobile, or both)
4. **Existing Cognito User Pool** (already configured in this project)
5. **PostConfirmation Lambda** (already configured to create DynamoDB records)

---

## AWS Cognito Configuration

### Step 1: Configure Google as an Identity Provider

Add Google as a federated identity provider in your Cognito User Pool. This can be done via:

**Option A: AWS Console**
1. Navigate to AWS Cognito → User Pools → Your User Pool
2. Go to "Sign-in experience" → "Federated identity provider sign-in"
3. Click "Add identity provider"
4. Select "Google"
5. Enter your Google Client ID and Client Secret (from Google Cloud Console)
6. Configure attribute mapping:
   - `email` → `email`
   - `name` → `name`
   - `sub` → `username` (or leave as default)
7. Save the configuration

**Option B: CloudFormation/Serverless Framework**

Add the following to `resources.yml`:

```yaml
CognitoUserPoolIdentityProvider:
  Type: AWS::Cognito::UserPoolIdentityProvider
  Properties:
    UserPoolId: !Ref CognitoUserPool
    ProviderName: Google
    ProviderType: Google
    ProviderDetails:
      client_id: ${env:GOOGLE_CLIENT_ID}
      client_secret: ${env:GOOGLE_CLIENT_SECRET}
      authorize_scopes: openid email profile
    AttributeMapping:
      email: email
      name: name
      username: sub
```

**Environment Variables:**
- `GOOGLE_CLIENT_ID`: Your Google OAuth 2.0 Client ID
- `GOOGLE_CLIENT_SECRET`: Your Google OAuth 2.0 Client Secret

### Step 2: Update Cognito User Pool Client

The User Pool Client must support OAuth flows and include Google as a supported identity provider.

**Update `resources.yml`:**

```yaml
CognitoUserPoolClient:
  Type: AWS::Cognito::UserPoolClient
  Properties:
    ClientName: podpdf-${self:provider.stage}-client
    UserPoolId: !Ref CognitoUserPool
    GenerateSecret: false
    ExplicitAuthFlows:
      - ALLOW_USER_PASSWORD_AUTH
      - ALLOW_REFRESH_TOKEN_AUTH
      - ALLOW_USER_SRP_AUTH
    SupportedIdentityProviders:
      - COGNITO
      - Google  # Add Google as a supported provider
    CallbackURLs:
      - http://localhost:3000/auth/callback
      - https://podpdf.com/auth/callback
      - https://www.podpdf.com/auth/callback
      - https://app.podpdf.com/auth/callback
    LogoutURLs:
      - http://localhost:3000/auth/logout
      - https://podpdf.com/auth/logout
      - https://www.podpdf.com/auth/logout
      - https://app.podpdf.com/auth/logout
    AllowedOAuthFlows:
      - code
      - implicit
    AllowedOAuthScopes:
      - email
      - openid
      - profile
    AllowedOAuthFlowsUserPoolClient: true
    TokenValidityUnits:
      AccessToken: hours
      IdToken: hours
      RefreshToken: days
    AccessTokenValidity: 24
    IdTokenValidity: 24
    RefreshTokenValidity: 30
```

### Step 3: Update Cognito User Pool Domain

Ensure the User Pool Domain is configured (already exists in `resources.yml`):

```yaml
CognitoUserPoolDomain:
  Type: AWS::Cognito::UserPoolDomain
  Properties:
    Domain: podpdf-${self:provider.stage}-auth
    UserPoolId: !Ref CognitoUserPool
```

**Domain URL Format:**
- `https://podpdf-{stage}-auth.auth.{region}.amazoncognito.com`

---

## Google Cloud Console Setup

### Step 1: Create OAuth 2.0 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create a new one)
3. Navigate to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth client ID**
5. Configure OAuth consent screen (if not already done):
   - User Type: External (or Internal for G Suite)
   - App name: PodPDF
   - User support email: your email
   - Developer contact: your email
   - Scopes: `email`, `profile`, `openid`
6. Create OAuth client:
   - Application type: **Web application**
   - Name: PodPDF Web Client
   - Authorized JavaScript origins:
     - `http://localhost:3000`
     - `https://podpdf.com`
     - `https://www.podpdf.com`
     - `https://app.podpdf.com`
   - Authorized redirect URIs:
     - `https://podpdf-{stage}-auth.auth.{region}.amazoncognito.com/oauth2/idpresponse`
     - Example: `https://podpdf-dev-auth.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse`
     - Example: `https://podpdf-prod-auth.auth.eu-central-1.amazoncognito.com/oauth2/idpresponse`

### Step 2: Get Client ID and Secret

After creating the OAuth client:
- **Client ID**: Copy this value (you'll need it for Cognito)
- **Client Secret**: Copy this value (you'll need it for Cognito)

**Important:** Store these securely. For Serverless Framework, use environment variables or AWS Secrets Manager.

---

## Client-Side Implementation

### Option 1: Using AWS Amplify (Recommended)

AWS Amplify provides built-in support for Cognito federated identities.

#### Installation

```bash
npm install aws-amplify @aws-amplify/auth
```

#### Configuration

```javascript
import { Amplify } from 'aws-amplify';
import { signIn } from 'aws-amplify/auth';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: 'eu-central-1_XXXXXXXXX', // Your User Pool ID
      userPoolClientId: 'XXXXXXXXXXXXXXXXXXXXXXXXXX', // Your Client ID
      loginWith: {
        oauth: {
          domain: 'podpdf-dev-auth.auth.eu-central-1.amazoncognito.com',
          scopes: ['openid', 'email', 'profile'],
          redirectSignIn: ['http://localhost:3000/auth/callback'],
          redirectSignOut: ['http://localhost:3000/auth/logout'],
          responseType: 'code',
          providers: ['Google'],
        },
      },
    },
  },
});
```

#### Sign In with Google

```javascript
import { signInWithRedirect } from 'aws-amplify/auth';

async function handleGoogleSignIn() {
  try {
    await signInWithRedirect({ provider: 'Google' });
  } catch (error) {
    console.error('Error signing in with Google:', error);
  }
}
```

#### Handle OAuth Callback

```javascript
import { fetchAuthSession } from 'aws-amplify/auth';
import { useEffect } from 'react';

function AuthCallback() {
  useEffect(() => {
    async function handleCallback() {
      try {
        // Amplify automatically handles the OAuth callback
        const { tokens } = await fetchAuthSession();
        
        if (tokens?.idToken) {
          // User is authenticated
          const idToken = tokens.idToken.toString();
          const accessToken = tokens.accessToken.toString();
          
          // Store tokens (e.g., in localStorage or secure storage)
          localStorage.setItem('idToken', idToken);
          localStorage.setItem('accessToken', accessToken);
          
          // Redirect to app
          window.location.href = '/dashboard';
        }
      } catch (error) {
        console.error('Error handling OAuth callback:', error);
        // Redirect to login with error
        window.location.href = '/login?error=authentication_failed';
      }
    }
    
    handleCallback();
  }, []);
  
  return <div>Authenticating...</div>;
}
```

### Option 2: Using Cognito Hosted UI (Direct)

You can redirect users directly to Cognito's hosted UI, which handles Google OAuth.

#### Redirect to Hosted UI

```javascript
function signInWithGoogle() {
  const region = 'eu-central-1';
  const userPoolId = 'eu-central-1_XXXXXXXXX';
  const clientId = 'XXXXXXXXXXXXXXXXXXXXXXXXXX';
  const domain = 'podpdf-dev-auth.auth.eu-central-1.amazoncognito.com';
  const redirectUri = encodeURIComponent('http://localhost:3000/auth/callback');
  
  const hostedUIUrl = `https://${domain}/oauth2/authorize?` +
    `client_id=${clientId}&` +
    `response_type=code&` +
    `scope=openid+email+profile&` +
    `redirect_uri=${redirectUri}&` +
    `identity_provider=Google`;
  
  window.location.href = hostedUIUrl;
}
```

#### Handle Callback and Exchange Code for Tokens

```javascript
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

async function handleOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const error = urlParams.get('error');
  
  if (error) {
    console.error('OAuth error:', error);
    return;
  }
  
  if (!code) {
    console.error('No authorization code received');
    return;
  }
  
  // Exchange authorization code for tokens
  const region = 'eu-central-1';
  const clientId = 'XXXXXXXXXXXXXXXXXXXXXXXXXX';
  const redirectUri = 'http://localhost:3000/auth/callback';
  
  const cognitoClient = new CognitoIdentityProviderClient({ region });
  
  try {
    const command = new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: 'AuthorizationCode',
      AuthParameters: {
        code: code,
        redirect_uri: redirectUri,
      },
    });
    
    const response = await cognitoClient.send(command);
    
    if (response.AuthenticationResult) {
      const { IdToken, AccessToken, RefreshToken } = response.AuthenticationResult;
      
      // Store tokens
      localStorage.setItem('idToken', IdToken);
      localStorage.setItem('accessToken', AccessToken);
      localStorage.setItem('refreshToken', RefreshToken);
      
      // Redirect to app
      window.location.href = '/dashboard';
    }
  } catch (error) {
    console.error('Error exchanging code for tokens:', error);
    window.location.href = '/login?error=token_exchange_failed';
  }
}
```

**Note:** The AuthorizationCode flow requires a backend endpoint to exchange the code securely (client secret should not be exposed). Consider using a Lambda function for this.

### Option 3: Using Google Identity Services (gsi) + Cognito

For more control, you can use Google's Identity Services library and then federate with Cognito.

#### Install Google Identity Services

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

#### Initialize Google Sign-In

```javascript
window.onload = function () {
  google.accounts.id.initialize({
    client_id: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
    callback: handleGoogleCredentialResponse,
  });
  
  google.accounts.id.renderButton(
    document.getElementById('google-signin-button'),
    { theme: 'outline', size: 'large' }
  );
};

async function handleGoogleCredentialResponse(response) {
  const credential = response.credential; // JWT from Google
  
  // Exchange Google JWT for Cognito tokens via backend
  try {
    const result = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    
    const { idToken, accessToken, refreshToken } = await result.json();
    
    // Store tokens
    localStorage.setItem('idToken', idToken);
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    
    // Redirect to app
    window.location.href = '/dashboard';
  } catch (error) {
    console.error('Error federating with Cognito:', error);
  }
}
```

#### Backend Endpoint to Exchange Google JWT for Cognito Tokens

Create a new Lambda handler or add to existing auth handler:

```javascript
const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

async function exchangeGoogleTokenForCognitoTokens(event) {
  const { credential } = JSON.parse(event.body);
  const clientId = process.env.COGNITO_USER_POOL_CLIENT_ID;
  
  const cognitoClient = new CognitoIdentityProviderClient({});
  
  try {
    const command = new InitiateAuthCommand({
      ClientId: clientId,
      AuthFlow: 'CustomAuthFlow', // Or use OAuth flow
      AuthParameters: {
        'id_token': credential, // Google JWT
        'provider': 'Google',
      },
    });
    
    const response = await cognitoClient.send(command);
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        idToken: response.AuthenticationResult.IdToken,
        accessToken: response.AuthenticationResult.AccessToken,
        refreshToken: response.AuthenticationResult.RefreshToken,
      }),
    };
  } catch (error) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Authentication failed' }),
    };
  }
}
```

**Note:** This approach is more complex. Option 1 (Amplify) or Option 2 (Hosted UI) are recommended.

---

## Authentication Flow

### Complete Flow Diagram

```
1. User clicks "Sign in with Google"
   ↓
2. Client redirects to Cognito Hosted UI (or uses Amplify)
   ↓
3. Cognito redirects to Google OAuth consent screen
   ↓
4. User approves and Google redirects back to Cognito
   ↓
5. Cognito validates Google token and creates/updates federated identity
   ↓
6. Cognito triggers PostConfirmation Lambda (if new user)
   ↓
7. PostConfirmation Lambda creates user record in DynamoDB
   ↓
8. Cognito returns authorization code to client callback URL
   ↓
9. Client exchanges code for Cognito tokens (IdToken, AccessToken, RefreshToken)
   ↓
10. Client stores tokens and user is authenticated
```

### First-Time User Flow

1. User signs in with Google for the first time
2. Cognito creates a new federated identity linked to Google
3. PostConfirmation trigger fires (if configured)
4. PostConfirmation Lambda creates user record in DynamoDB with:
   - `user_sub`: Cognito user sub (format: `Google_XXXXXXXXX`)
   - `email`: From Google profile
   - `display_name`: From Google profile (name attribute)
   - `plan_id`: 'free-basic'
   - `account_status`: 'free'

### Returning User Flow

1. User signs in with Google
2. Cognito recognizes existing federated identity
3. PostConfirmation trigger does NOT fire (user already exists)
4. Cognito returns tokens
5. User is authenticated

### Token Structure

Cognito JWT tokens contain the following claims:

**IdToken:**
```json
{
  "sub": "Google_XXXXXXXXX",
  "email": "user@example.com",
  "email_verified": true,
  "name": "John Doe",
  "identities": [
    {
      "userId": "XXXXXXXXX",
      "providerName": "Google",
      "providerType": "Google",
      "issuer": "https://accounts.google.com",
      "primary": "true",
      "dateCreated": "1234567890000"
    }
  ],
  "iss": "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_XXXXXXXXX",
  "aud": "XXXXXXXXXXXXXXXXXXXXXXXXXX",
  "exp": 1234567890,
  "iat": 1234567890
}
```

**AccessToken:**
- Contains user claims and scopes
- Used for API authorization

**RefreshToken:**
- Used to obtain new IdToken and AccessToken
- Valid for 30 days (as configured)

---

## Backend Integration

### Existing Endpoints Work Automatically

All existing API endpoints that use `cognitoAuthorizer` will work with Google-authenticated users:

- `GET /accounts/me` - Returns user account info
- `GET /jobs` - Lists user's jobs
- `POST /accounts/me/credits/purchase` - Purchase credits
- All other authenticated endpoints

The JWT tokens from Google-authenticated users are identical in structure to email/password tokens, so no backend changes are required.

### PostConfirmation Lambda

The existing `cognito-post-confirmation` handler already handles federated identities:

```javascript
// src/handlers/cognito-post-confirmation.js
const userSub = event.request?.userAttributes?.sub;
const email = event.request?.userAttributes?.email;
const name = event.request?.userAttributes?.name || null;
```

For Google users:
- `userSub` will be in format: `Google_XXXXXXXXX`
- `email` will be from Google profile
- `name` will be from Google profile (if mapped)

**No changes needed** - the handler already works with federated identities.

### Extracting User Information

The `extractUserSub` function in `src/middleware/auth.js` works with both:
- Email/password users: `sub` = Cognito UUID
- Google users: `sub` = `Google_XXXXXXXXX`

Both formats are valid and can be used to look up users in DynamoDB.

---

## Error Handling

### Common Errors

#### 1. Invalid Client Configuration

**Error:** `InvalidOAuthFlowException`

**Cause:** User Pool Client not configured for OAuth flows

**Solution:** Ensure `AllowedOAuthFlowsUserPoolClient: true` and `AllowedOAuthFlows` includes `code` or `implicit`

#### 2. Redirect URI Mismatch

**Error:** `InvalidParameterException: redirect_uri_mismatch`

**Cause:** Callback URL not in allowed list

**Solution:** Add callback URL to `CallbackURLs` in User Pool Client configuration

#### 3. Google Provider Not Found

**Error:** `ResourceNotFoundException`

**Cause:** Google identity provider not configured in User Pool

**Solution:** Configure Google as identity provider in Cognito User Pool

#### 4. User Denies Permission

**Error:** `access_denied` in OAuth callback

**Cause:** User clicked "Cancel" on Google consent screen

**Solution:** Handle gracefully, show message to user

#### 5. PostConfirmation Lambda Error

**Error:** User authenticated but account not created in DynamoDB

**Cause:** PostConfirmation Lambda failed (logged but doesn't block authentication)

**Solution:** Check CloudWatch logs, ensure Lambda has DynamoDB permissions

### Error Handling in Client

```javascript
async function handleGoogleSignIn() {
  try {
    await signInWithRedirect({ provider: 'Google' });
  } catch (error) {
    if (error.name === 'InvalidParameterException') {
      console.error('Invalid configuration:', error.message);
    } else if (error.name === 'NotAuthorizedException') {
      console.error('Authentication failed:', error.message);
    } else {
      console.error('Unexpected error:', error);
    }
    
    // Show user-friendly error message
    showError('Failed to sign in with Google. Please try again.');
  }
}
```

---

## Testing

### Test Scenarios

1. **First-time Google Sign-In**
   - Sign in with Google account that hasn't been used before
   - Verify user record created in DynamoDB
   - Verify tokens received
   - Verify can access authenticated endpoints

2. **Returning Google User**
   - Sign in with Google account that was used before
   - Verify tokens received
   - Verify existing user data is accessible

3. **Email Already Exists**
   - Sign up with email/password
   - Try to sign in with Google using same email
   - Expected: Cognito may create separate identity or link identities (depends on configuration)

4. **Token Refresh**
   - Sign in with Google
   - Wait for token expiration
   - Use refresh token to get new tokens
   - Verify new tokens work

5. **Error Cases**
   - Test with invalid redirect URI
   - Test user cancellation
   - Test network errors

### Manual Testing Steps

1. **Setup:**
   ```bash
   # Deploy infrastructure with Google provider
   serverless deploy --stage dev
   ```

2. **Test Sign-In:**
   - Open client application
   - Click "Sign in with Google"
   - Complete Google OAuth flow
   - Verify redirected back to app
   - Verify tokens stored
   - Verify can call `GET /accounts/me`

3. **Verify DynamoDB:**
   ```bash
   aws dynamodb get-item \
     --table-name podpdf-dev-users \
     --key '{"user_sub": {"S": "Google_XXXXXXXXX"}}'
   ```

4. **Test API Call:**
   ```bash
   curl -H "Authorization: Bearer $ID_TOKEN" \
     https://api.podpdf.com/accounts/me
   ```

---

## Security Considerations

### 1. Client Secret Security

**Never expose Google Client Secret or Cognito Client Secret in client-side code.**

- Use environment variables in backend
- Use AWS Secrets Manager for production
- Only Client ID should be in client code

### 2. HTTPS Only

- Always use HTTPS in production
- OAuth redirects must use HTTPS
- Cognito Hosted UI requires HTTPS (except localhost)

### 3. Token Storage

- **Web:** Use `httpOnly` cookies or secure storage (not localStorage for sensitive apps)
- **Mobile:** Use secure keychain/keystore
- **Never:** Store tokens in plain text or unencrypted storage

### 4. Token Validation

- Always validate JWT tokens on backend
- Check token expiration
- Verify token signature
- Validate audience and issuer

### 5. CORS Configuration

- Configure CORS to only allow trusted origins
- Don't use `*` for `allowedOrigins` in production
- Include credentials handling if needed

### 6. Redirect URI Validation

- Only allow specific, known redirect URIs
- Don't use wildcards in production
- Validate redirect URI on backend if implementing custom flow

### 7. Attribute Mapping

- Only map necessary attributes from Google
- Don't expose sensitive information unnecessarily
- Validate email verification status

### 8. Rate Limiting

- Implement rate limiting on OAuth endpoints
- Monitor for suspicious activity
- Use Cognito's built-in rate limiting

---

## Additional Resources

- [AWS Cognito Federated Identities Documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation.html)
- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [AWS Amplify Auth Documentation](https://docs.amplify.aws/react/build-a-backend/auth/)
- [Cognito Hosted UI Documentation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-app-integration.html)

---

## Implementation Checklist

- [ ] Create Google OAuth 2.0 credentials in Google Cloud Console
- [ ] Configure Google as identity provider in Cognito User Pool
- [ ] Update Cognito User Pool Client to support Google provider
- [ ] Add Google Client ID and Secret to environment variables
- [ ] Update callback URLs in both Google and Cognito
- [ ] Implement client-side Google sign-in (choose one approach)
- [ ] Test first-time user flow
- [ ] Test returning user flow
- [ ] Test error handling
- [ ] Verify PostConfirmation Lambda creates user records
- [ ] Test API calls with Google-authenticated tokens
- [ ] Update CORS configuration if needed
- [ ] Deploy to production
- [ ] Monitor CloudWatch logs for errors

---

## Notes

- Google-authenticated users will have `user_sub` in format `Google_XXXXXXXXX`
- The PostConfirmation trigger fires for new federated identities
- Existing API endpoints work without modification
- Tokens from Google users are identical in structure to email/password tokens
- Consider implementing account linking if users want to link Google and email/password accounts

