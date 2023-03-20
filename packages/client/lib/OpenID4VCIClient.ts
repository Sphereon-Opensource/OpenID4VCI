import {
  AccessTokenResponse,
  Alg,
  AuthorizationRequest,
  AuthorizationRequestOpts,
  AuthzFlowType,
  CredentialMetadataV1_09,
  CredentialOffer,
  CredentialResponse,
  CredentialsSupported,
  EndpointMetadata,
  IssuanceInitiationWithBaseUrl,
  OIDCVCIVersion,
  ProofOfPossessionCallbacks,
  ResponseType,
} from '@sphereon/openid4vci-common';
import {CredentialFormat} from '@sphereon/ssi-types';
import Debug from 'debug';

import {AccessTokenClient} from './AccessTokenClient';
import {CredentialRequestClientBuilder} from './CredentialRequestClientBuilder';
import {CredentialOfferIssuance, CredentialOfferStrategy, discoverOIDCVCIVersion, IssuanceInitiation} from './CredentialOffer';
import {MetadataClient} from './MetadataClient';
import {ProofOfPossessionBuilder} from './ProofOfPossessionBuilder';
import {convertJsonToURI} from './functions';

const debug = Debug('sphereon:openid4vci:flow');

export class OpenID4VCIClient {
  private readonly _flowType: AuthzFlowType;
  private readonly _credentialOffer: CredentialOffer;
  private _clientId?: string;
  private _kid: string | undefined;
  private _alg: Alg | string | undefined;
  private _serverMetadata: EndpointMetadata | undefined;
  private _accessTokenResponse: AccessTokenResponse | undefined;
  private readonly _oidcvciVersion: OIDCVCIVersion;

  private constructor(
      credentialOffer: CredentialOffer,
      flowType: AuthzFlowType,
      oidcvciVersion: OIDCVCIVersion,
      kid?: string,
      alg?: Alg | string,
      clientId?: string
  ) {
    this._flowType = flowType;
    this._credentialOffer = credentialOffer;
    this._kid = kid;
    this._alg = alg;
    this._clientId = clientId;
    this._oidcvciVersion = oidcvciVersion;
  }

  public static async credentialOffer({
    credentialOfferURI,
    flowType,
    kid,
    alg,
    retrieveServerMetadata,
    clientId,
  }: {
    credentialOfferURI: string;
    flowType: AuthzFlowType;
    kid?: string;
    alg?: Alg | string;
    retrieveServerMetadata?: boolean;
    clientId?: string;
  }): Promise<OpenID4VCIClient> {

    let oidcvciVersion = discoverOIDCVCIVersion(credentialOfferURI);

    const flow = new OpenID4VCIClient(OpenID4VCIClient.getStrategy(oidcvciVersion).getCredentialOffer(credentialOfferURI), flowType, oidcvciVersion, kid, alg, clientId);
    if (retrieveServerMetadata) {
      await flow.retrieveServerMetadata();
    }
    return flow;
  }

  public static getStrategy(oidcvciVersion: OIDCVCIVersion): CredentialOfferStrategy {
    if(OIDCVCIVersion.VER_9 === oidcvciVersion) {
      return new IssuanceInitiation();
    } else if (OIDCVCIVersion.VER_11 === oidcvciVersion) {
      return new CredentialOfferIssuance();
    }

    throw new Error('unexpected version')
  }

  public async retrieveServerMetadata(): Promise<EndpointMetadata> {
    this.assertInitiation();
    if (!this._serverMetadata) {
      this._serverMetadata = await MetadataClient.retrieveAllMetadataFromInitiation(this._credentialOffer);
    }
    return this._serverMetadata;
  }

  public createAuthorizationRequestUrl({ clientId, codeChallengeMethod, codeChallenge, redirectUri, scope }: AuthorizationRequestOpts): string {
    if (!scope) {
      throw Error('Please provide a scope. authorization_details based requests are not supported at this time');
    }

    if (!this._serverMetadata?.openid4vci_metadata?.authorization_endpoint) {
      throw Error('Server metadata does not contain authorization endpoint');
    }

    // add 'openid' scope if not present
    if (!scope.includes('openid')) {
      scope = `openid ${scope}`;
    }

    const queryObj: AuthorizationRequest = {
      response_type: ResponseType.AUTH_CODE,
      client_id: clientId,
      code_challenge_method: codeChallengeMethod,
      code_challenge: codeChallenge,
      redirect_uri: redirectUri,
      scope: scope,
    };

    return convertJsonToURI(queryObj, {
      baseUrl: this._serverMetadata.openid4vci_metadata.authorization_endpoint,
      uriTypeProperties: ['redirect_uri', 'scope'],
    });
  }

  public async acquireAccessToken({
    pin,
    clientId,
    codeVerifier,
    code,
    redirectUri,
  }: {
    pin?: string;
    clientId?: string;
    codeVerifier?: string;
    code?: string;
    redirectUri?: string;
  }): Promise<AccessTokenResponse> {
    this.assertInitiation();
    if (clientId) {
      this._clientId = clientId;
    }
    if (!this._accessTokenResponse) {
      const accessTokenClient = new AccessTokenClient();

      const response = await accessTokenClient.acquireAccessTokenUsingIssuanceInitiation({
        issuanceInitiation: this._credentialOffer,
        metadata: this._serverMetadata,
        pin,
        codeVerifier,
        code,
        redirectUri,
        asOpts: { clientId: this.clientId },
      });
      if (response.errorBody) {
        debug(`Access token error:\r\n${response.errorBody}`);
        throw Error(
          `Retrieving an access token from ${this._serverMetadata?.token_endpoint} for issuer ${this._credentialOffer.issuanceInitiationRequest.issuer} failed with status: ${response.origResponse.status}`
        );
      } else if (!response.successBody) {
        debug(`Access token error. No succes body`);
        throw Error(
          `Retrieving an access token from ${this._serverMetadata?.token_endpoint} for issuer ${this._credentialOffer.issuanceInitiationRequest.issuer} failed as there was no success response body`
        );
      }
      this._accessTokenResponse = response.successBody;
    }

    return this._accessTokenResponse;
  }

  public async acquireCredentials({
    credentialType,
    proofCallbacks,
    format,
    kid,
    alg,
    jti,
  }: {
    credentialType: string | string[];
    proofCallbacks: ProofOfPossessionCallbacks;
    format?: CredentialFormat | CredentialFormat[];
    kid?: string;
    alg?: Alg | string;
    jti?: string;
  }): Promise<CredentialResponse> {
    if (alg) {
      this._alg = alg;
    }
    if (kid) {
      this._kid = kid;
    }

    const requestBuilder = CredentialRequestClientBuilder.fromIssuanceInitiation({
      initiation: this.credentialOffer,
      metadata: this.serverMetadata,
    });
    requestBuilder.withToken(this.accessTokenResponse.access_token);
    if (this.serverMetadata?.openid4vci_metadata) {
      const metadata = this.serverMetadata.openid4vci_metadata;
      const types = Array.isArray(credentialType) ? credentialType : [credentialType];
      if (types.some((type) => !metadata.credentials_supported || !metadata.credentials_supported[type])) {
        throw Error(`Not all credential types ${JSON.stringify(credentialType)} are supported by issuer ${this.getIssuer()}`);
      }
      // todo: Format check? We might end up with some disjoint type / format combinations supported by the server
    }
    const credentialRequestClient = requestBuilder.build();
    const proofBuilder = ProofOfPossessionBuilder.fromAccessTokenResponse({
      accessTokenResponse: this.accessTokenResponse,
      callbacks: proofCallbacks,
    })
      .withIssuer(this.getIssuer())
      .withAlg(this.alg)
      .withClientId(this.clientId)
      .withKid(this.kid);

    if (jti) {
      proofBuilder.withJti(jti);
    }
    const response = await credentialRequestClient.acquireCredentialsUsingProof({
      proofInput: proofBuilder,
      credentialType,
      format,
    });
    if (response.errorBody) {
      debug(`Credential request error:\r\n${response.errorBody}`);
      throw Error(
        `Retrieving a credential from ${this._serverMetadata?.credential_endpoint} for issuer ${this._credentialOffer.issuanceInitiationRequest.issuer} failed with status: ${response.origResponse.status}`
      );
    } else if (!response.successBody) {
      debug(`Credential request error. No success body`);
      throw Error(
        `Retrieving a credential from ${this._serverMetadata?.credential_endpoint} for issuer ${this._credentialOffer.issuanceInitiationRequest.issuer} failed as there was no success response body`
      );
    }
    return response.successBody;
  }

  getCredentialsSupported(restrictToInitiationTypes: boolean): CredentialsSupported {
    const credentialsSupported = this.serverMetadata?.openid4vci_metadata?.credentials_supported;
    if (!credentialsSupported) {
      return {};
    } else if (!restrictToInitiationTypes) {
      return credentialsSupported;
    }
    const initiationTypes = this.getCredentialTypesFromInitiation();
    const supported: CredentialsSupported = {};
    for (const [key, value] of Object.entries(credentialsSupported)) {
      if (initiationTypes.includes(key)) {
        supported[key] = value;
      }
    }
    return supported;
  }

  getCredentialMetadata(type: string): CredentialMetadataV1_09 {
    return this.getCredentialsSupported(false)[type];
  }

  getCredentialTypesFromInitiation(): string[] {
    return typeof this.credentialOffer.issuanceInitiationRequest.credential_type === 'string'
      ? [this.credentialOffer.issuanceInitiationRequest.credential_type]
      : this.credentialOffer.issuanceInitiationRequest.credential_type;
  }

  get flowType(): AuthzFlowType {
    return this._flowType;
  }

  get credentialOffer(): IssuanceInitiationWithBaseUrl {
    return this._credentialOffer;
  }

  get serverMetadata(): EndpointMetadata {
    this.assertServerMetadata();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._serverMetadata!;
  }

  get kid(): string {
    this.assertInitiation();
    if (!this._kid) {
      throw new Error('No value for kid is supplied');
    }
    return this._kid;
  }

  get alg(): string {
    this.assertInitiation();
    if (!this._alg) {
      throw new Error('No value for alg is supplied');
    }
    return this._alg;
  }

  get clientId(): string {
    if (!this._clientId) {
      throw Error('No client id present');
    }
    return this._clientId;
  }

  get accessTokenResponse(): AccessTokenResponse {
    this.assertAccessToken();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this._accessTokenResponse!;
  }

  public getIssuer(): string {
    this.assertInitiation();
    return this._serverMetadata ? this.serverMetadata.issuer : this.credentialOffer.issuanceInitiationRequest.issuer;
  }

  public getAccessTokenEndpoint(): string {
    this.assertInitiation();
    return this.serverMetadata
      ? this.serverMetadata.token_endpoint
      : AccessTokenClient.determineTokenURL({ issuerOpts: { issuer: this.getIssuer() } });
  }

  public getCredentialEndpoint(): string {
    this.assertInitiation();
    return this.serverMetadata ? this.serverMetadata.credential_endpoint : `${this.getIssuer()}/credential`;
  }

  private assertInitiation(): void {
    if (!this._credentialOffer) {
      throw Error(`No issuance initiation present`);
    }
  }

  private assertServerMetadata(): void {
    if (!this._serverMetadata) {
      throw Error('No server metadata');
    }
  }

  private assertAccessToken(): void {
    if (!this._accessTokenResponse) {
      throw Error(`No access token present`);
    }
  }
}
