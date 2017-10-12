import { PLATFORM_ID, Inject } from '@angular/core';
import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { Injectable, EventEmitter, Output } from '@angular/core';
import { Http, Response, URLSearchParams } from '@angular/http';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/catch';
import { Observable } from 'rxjs/Rx';
import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import { Router } from '@angular/router';
import { AuthConfiguration, OpenIDImplicitFlowConfiguration } from '../modules/auth.configuration';
import { OidcSecurityValidation } from './oidc.security.validation';
import { OidcSecurityCheckSession } from './oidc.security.check-session';
import { OidcSecuritySilentRenew } from './oidc.security.silent-renew';
import { OidcSecurityUserService } from './oidc.security.user-service';
import { OidcSecurityCommon } from './oidc.security.common';
import { AuthWellKnownEndpoints } from './auth.well-known-endpoints';

import { JwtKeys } from './jwtkeys';

@Injectable()
export class OidcSecurityService {

    @Output() onModuleSetup: EventEmitter<any> = new EventEmitter<any>(true);

    checkSessionChanged: boolean;
    moduleSetup = false;
    private _isAuthorized = new BehaviorSubject<boolean>(false);
    private _isAuthorizedValue: boolean;

    private _userData = new BehaviorSubject<any>('');
    private _userDataValue: boolean;

    public oidcSecurityValidation: OidcSecurityValidation;
    private errorMessage: string;
    private jwtKeys: JwtKeys;
    private authWellKnownEndpointsLoaded = false;

    private CheckForPopupClosedInterval: number;
    private _checkForPopupClosedTimer: any;
    private _popup: any;
    private _popupFor: string;

    constructor(
        @Inject(PLATFORM_ID) private platformId: Object,
        private http: Http,
        private authConfiguration: AuthConfiguration,
        private router: Router,
        private oidcSecurityCheckSession: OidcSecurityCheckSession,
        private oidcSecuritySilentRenew: OidcSecuritySilentRenew,
        private oidcSecurityUserService: OidcSecurityUserService,
        private oidcSecurityCommon: OidcSecurityCommon,
        private authWellKnownEndpoints: AuthWellKnownEndpoints
    ) {
    }

    setupModule(openIDImplicitFlowConfiguration: OpenIDImplicitFlowConfiguration) {

        this.authConfiguration.init(openIDImplicitFlowConfiguration);
        this.oidcSecurityValidation = new OidcSecurityValidation(this.oidcSecurityCommon);

        this.oidcSecurityCheckSession.onCheckSessionChanged.subscribe(() => { this.onCheckSessionChanged(); });
        this.authWellKnownEndpoints.onWellKnownEndpointsLoaded.subscribe(() => { this.onWellKnownEndpointsLoaded(); });

        this.oidcSecurityCommon.setupModule();

        if (this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_user_data) !== '') {
            this.setUserData(this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_user_data));
        }

        if (this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_is_authorized) !== '') {
            this.setIsAuthorized(this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_is_authorized));
        }

        this.oidcSecurityCommon.logDebug('STS server: ' + this.authConfiguration.stsServer);

        if (isPlatformBrowser(this.platformId)) {
            // Client only code.
            this.authWellKnownEndpoints.setupModule();

            if (this.authConfiguration.silent_renew) {
                this.oidcSecuritySilentRenew.initRenew();
            }

            if (this.authConfiguration.start_checksession) {
                this.oidcSecurityCheckSession.init().subscribe(() => {
                    this.oidcSecurityCheckSession.pollServerSession(this.authConfiguration.client_id);
                });
            }
        }

        this.moduleSetup = true;
        this.onModuleSetup.emit();
    }

    getUserData(): Observable<any> {
        return this._userData.asObservable();
    }

    private setUserData(userData: any) {
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_user_data, userData);
        this._userData.next(userData);
    }

    getIsAuthorized(): Observable<boolean> {
        return this._isAuthorized.asObservable();
    }

    private setIsAuthorized(isAuthorized: boolean) {
        this._isAuthorizedValue = isAuthorized;
        this._isAuthorized.next(isAuthorized);
    }

    getToken(): any {
        if (!this._isAuthorizedValue) {
            return '';
        }

        let token = this.oidcSecurityCommon.getAccessToken();
        return decodeURIComponent(token);
    }

    getIdToken(): any {
        if (!this._isAuthorizedValue) {
            return '';
        }

        let token = this.oidcSecurityCommon.getIdToken();
        return decodeURIComponent(token);
    }

    getPayloadFromIdToken(encode = false): any {
        const token = this.getIdToken();
        return this.oidcSecurityValidation.getPayloadFromToken(token, encode);
    }

    setCustomRequestParameters(params: { [key: string]: string | number | boolean }) {
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_custom_request_params, params);
    }

    getRefreshSessionUrl() {

        let data = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_well_known_endpoints);
        if (data && data !== '') {
            this.authWellKnownEndpointsLoaded = true;
        }

        if (!this.authWellKnownEndpointsLoaded) {
            this.oidcSecurityCommon.logError('Well known endpoints must be loaded before user can login!')
            return;
        }

        if (!this.oidcSecurityValidation.config_validate_response_type(this.authConfiguration.response_type)) {
            // invalid response_type
            return
        }

        //this.resetAuthorizationData(false);

        this.oidcSecurityCommon.logDebug('BEGIN Authorize, no auth data');

        let nonce = 'N' + Math.random() + '' + Date.now();
        let state = Date.now() + '' + Math.random();

        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_state_control, state);
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_nonce, nonce);
        this.oidcSecurityCommon.logDebug('AuthorizedController created. local state: ' + this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_state_control));

        let url = this.createAuthorizeUrl(nonce, state, this.authWellKnownEndpoints.authorization_endpoint);

        return url;

    }

    authorizeWithPopup(authenticationScheme: string = "local") {
        this._popupFor = "login";
        let data = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_well_known_endpoints);
        if (data && data !== '') {
            this.authWellKnownEndpointsLoaded = true;
        }

        if (!this.authWellKnownEndpointsLoaded) {
            this.oidcSecurityCommon.logError('Well known endpoints must be loaded before user can login!')
            return;
        }

        if (!this.oidcSecurityValidation.config_validate_response_type(this.authConfiguration.response_type)) {
            // invalid response_type
            return
        }

        this.resetAuthorizationData(false);

        this.oidcSecurityCommon.logDebug('BEGIN Authorize, no auth data');

        let nonce = 'N' + Math.random() + '' + Date.now();
        let state = Date.now() + '' + Math.random();

        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_state_control, state);
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_nonce, nonce);
        this.oidcSecurityCommon.logDebug('AuthorizedController created. local state: ' + this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_state_control));

        let url = this.createAuthorizeUrl(nonce, state, this.authWellKnownEndpoints.authorization_endpoint);

        url = url + "&authenticationScheme="+authenticationScheme;

        console.log(url);

        if(this._popupFor == "afterRegistration") {
          this._popup.location.href = url;
        } else {
          this.popup(url, 'QPONS\' AUTHORIZATION PAGE', 800, 800);
        }

        //window.location.href = url;
    }

    popup(url: string, title: string, w: number, h: number) {
      let options: string;
      this.CheckForPopupClosedInterval = 2000;

      let dualScreenLeft = window.screenLeft != undefined ? window.screenLeft : 0;
      let dualScreenTop = window.screenTop != undefined ? window.screenTop : 0;

      let width = window.innerWidth ? window.innerWidth : document.documentElement.clientWidth ? document.documentElement.clientWidth : window.screen.width;
      let height = window.innerHeight ? window.innerHeight : document.documentElement.clientHeight ? document.documentElement.clientHeight : window.screen.height;

      let left = ((width / 2) - (w / 2)) + dualScreenLeft;
      let top = ((height / 2) - (h / 2)) + dualScreenTop;

      options += 'toolbar=no,location=no,directories=no,status=no';
      options += ',menubar=no,scrollbars=no,resizable=no,copyhistory=no';

      options += ',width='  + w;
      options += ',height=' + h;
      options += ',top='    + top;
      options += ',left='   + left;

      this._popup = window.open(url, title, options);
      if(this._popupFor == "login") {
        this._checkForPopupClosedTimer = window.setInterval(this._checkForPopupClosed.bind(this), this.CheckForPopupClosedInterval);
      } else if(this._popupFor == "logout") {
        this._checkForPopupClosedTimer = window.setInterval(this._checkForLogoutPopupClosed.bind(this), this.CheckForPopupClosedInterval);
      }
    }

    popup_cleanup() {

        window.clearInterval(this._checkForPopupClosedTimer);
        this._checkForPopupClosedTimer = null;
        this._popup = null;

    }

    _checkForPopupClosed() {
      try {
        //console.log(this._popup.location.href);
        if(this._popup.location.href != 'about:blank' && this._popup.location.href != undefined) {
            let a = this._popup.location.href.split('/');
            a = a[(a.length - 1)];
          if(a != 'login') {
            this._popup.close();
            if (!this._popup || this._popup.closed) {
                //console.log("Popup window closed");
                  this.authorizedCallbackForPopup();
                  this.popup_cleanup();
                //this.authorize();
            }
          } else {
            if (!this._popup || this._popup.closed) {
              this.popup_cleanup();
            } else {
              this._popupFor = "afterRegistration";
              this.authorizeWithPopup();
            }
          }

        }
      } catch(err) {
        //console.log(err);
      }
    }

    _checkForLogoutPopupClosed() {
      try {
        //console.log(this._popup.location.href);
        if(this._popup.location.href != 'about:blank') {
          this._popup.close();
          if (!this._popup || this._popup.closed) {
              console.log("Popup window closed");
              //this.authorize();
              this.popup_cleanup();
          }
        }
      } catch(err) {
        //console.log(err);
      }
    }

    authorizedCallbackForPopup() {
        let silentRenew = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_silent_renew_running);
        let isRenewProcess = (silentRenew === 'running');

        this.oidcSecurityCommon.logDebug('BEGIN authorizedCallback, no auth data');
        this.resetAuthorizationData(isRenewProcess);

        console.log(window.location.hash);

        let hash = this._popup.location.hash.substr(1);

        console.log(hash);

        let result: any = hash.split('&').reduce(function (result: any, item: string) {
            let parts = item.split('=');
            result[parts[0]] = parts[1];
            return result;
        }, {});

        console.log(result);

        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_result, result);

        this.oidcSecurityCommon.logDebug(result);
        this.oidcSecurityCommon.logDebug('authorizedCallback created, begin token validation');

        let access_token = '';
        let id_token = '';
        let authResponseIsValid = false;
        let decoded_id_token: any;

        this.getSigningKeys()
            .subscribe(jwtKeys => {
                this.jwtKeys = jwtKeys;

                if (!result.error) {

                    // validate state
                    if (this.oidcSecurityValidation.validateStateFromHashCallback(result.state, this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_state_control))) {
                        if (this.authConfiguration.response_type === 'id_token token') {
                            access_token = result.access_token;
                        }
                        id_token = result.id_token;

                        let headerDecoded;
                        decoded_id_token = this.oidcSecurityValidation.getPayloadFromToken(id_token, false);
                        headerDecoded = this.oidcSecurityValidation.getHeaderFromToken(id_token, false);

                        // validate jwt signature
                        if (this.oidcSecurityValidation.validate_signature_id_token(id_token, this.jwtKeys)) {
                            // validate nonce
                            if (this.oidcSecurityValidation.validate_id_token_nonce(decoded_id_token, this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_nonce))) {
                                // validate required fields id_token
                                if (this.oidcSecurityValidation.validate_required_id_token(decoded_id_token)) {
                                    // validate max offset from the id_token issue to now
                                    if (this.oidcSecurityValidation.validate_id_token_iat_max_offset(decoded_id_token, this.authConfiguration.max_id_token_iat_offset_allowed_in_seconds)) {
                                        // validate iss
                                        if (this.oidcSecurityValidation.validate_id_token_iss(decoded_id_token, this.authWellKnownEndpoints.issuer)) {
                                            // validate aud
                                            if (this.oidcSecurityValidation.validate_id_token_aud(decoded_id_token, this.authConfiguration.client_id)) {
                                                // validate_id_token_exp_not_expired
                                                if (this.oidcSecurityValidation.validate_id_token_exp_not_expired(decoded_id_token)) {
                                                    // flow id_token token
                                                    if (this.authConfiguration.response_type === 'id_token token') {
                                                        // valiadate at_hash and access_token
                                                        if (this.oidcSecurityValidation.validate_id_token_at_hash(access_token, decoded_id_token.at_hash) || !access_token) {
                                                            authResponseIsValid = true;
                                                            this.successful_validation();
                                                        } else {
                                                            this.oidcSecurityCommon.logWarning('authorizedCallback incorrect at_hash');
                                                        }
                                                    } else {
                                                        authResponseIsValid = true;
                                                        this.successful_validation();
                                                    }
                                                } else {
                                                    this.oidcSecurityCommon.logWarning('authorizedCallback token expired');
                                                }
                                            } else {
                                                this.oidcSecurityCommon.logWarning('authorizedCallback incorrect aud');
                                            }
                                        } else {
                                            this.oidcSecurityCommon.logWarning('authorizedCallback incorrect iss does not match authWellKnownEndpoints issuer');
                                        }
                                    } else {
                                        this.oidcSecurityCommon.logWarning('authorizedCallback Validation, iat rejected id_token was issued too far away from the current time');
                                    }
                                } else {
                                    this.oidcSecurityCommon.logDebug('authorizedCallback Validation, one of the REQUIRED properties missing from id_token');
                                }
                            } else {
                                this.oidcSecurityCommon.logWarning('authorizedCallback incorrect nonce');
                            }
                        } else {
                            this.oidcSecurityCommon.logDebug('authorizedCallback Signature validation failed id_token');
                        }
                    } else {
                        this.oidcSecurityCommon.logWarning('authorizedCallback incorrect state');
                    }
                }

                this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_silent_renew_running, '');

                if (authResponseIsValid) {
                    this.setAuthorizationData(access_token, id_token);
                    if (this.authConfiguration.auto_userinfo) {
                        this.getUserinfo(isRenewProcess, result, id_token, decoded_id_token).subscribe((response) => {
                            if (response) {
                                this.router.navigate([this.authConfiguration.startup_route]);
                            } else {
                                //this.router.navigate([this.authConfiguration.unauthorized_route]);
                            }
                        });
                    } else {
                        this.router.navigate([this.authConfiguration.startup_route]);
                    }
                } else { // some went wrong
                    this.oidcSecurityCommon.logDebug('authorizedCallback, token(s) validation failed, resetting');
                    this.resetAuthorizationData(false);
                    this.router.navigate([this.authConfiguration.unauthorized_route]);
                }
            });
    }

    authorizedCallback() {
        let silentRenew = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_silent_renew_running);
        let isRenewProcess = (silentRenew === 'running');

        this.oidcSecurityCommon.logDebug('BEGIN authorizedCallback, no auth data');
        this.resetAuthorizationData(isRenewProcess);

        let hash = window.location.hash.substr(1);

        let result: any = hash.split('&').reduce(function (result: any, item: string) {
            let parts = item.split('=');
            result[parts[0]] = parts[1];
            return result;
        }, {});

        console.log(result);

        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_result, result);

        this.oidcSecurityCommon.logDebug(result);
        this.oidcSecurityCommon.logDebug('authorizedCallback created, begin token validation');

        let access_token = '';
        let id_token = '';
        let authResponseIsValid = false;
        let decoded_id_token: any;

        this.getSigningKeys()
            .subscribe(jwtKeys => {
                this.jwtKeys = jwtKeys;

                if (!result.error) {

                    // validate state
                    if (this.oidcSecurityValidation.validateStateFromHashCallback(result.state, this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_state_control))) {
                        if (this.authConfiguration.response_type === 'id_token token') {
                            access_token = result.access_token;
                        }
                        id_token = result.id_token;

                        let headerDecoded;
                        decoded_id_token = this.oidcSecurityValidation.getPayloadFromToken(id_token, false);
                        headerDecoded = this.oidcSecurityValidation.getHeaderFromToken(id_token, false);

                        // validate jwt signature
                        if (this.oidcSecurityValidation.validate_signature_id_token(id_token, this.jwtKeys)) {
                            // validate nonce
                            if (this.oidcSecurityValidation.validate_id_token_nonce(decoded_id_token, this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_nonce))) {
                                // validate required fields id_token
                                if (this.oidcSecurityValidation.validate_required_id_token(decoded_id_token)) {
                                    // validate max offset from the id_token issue to now
                                    if (this.oidcSecurityValidation.validate_id_token_iat_max_offset(decoded_id_token, this.authConfiguration.max_id_token_iat_offset_allowed_in_seconds)) {
                                        // validate iss
                                        if (this.oidcSecurityValidation.validate_id_token_iss(decoded_id_token, this.authWellKnownEndpoints.issuer)) {
                                            // validate aud
                                            if (this.oidcSecurityValidation.validate_id_token_aud(decoded_id_token, this.authConfiguration.client_id)) {
                                                // validate_id_token_exp_not_expired
                                                if (this.oidcSecurityValidation.validate_id_token_exp_not_expired(decoded_id_token)) {
                                                    // flow id_token token
                                                    if (this.authConfiguration.response_type === 'id_token token') {
                                                        // valiadate at_hash and access_token
                                                        if (this.oidcSecurityValidation.validate_id_token_at_hash(access_token, decoded_id_token.at_hash) || !access_token) {
                                                            authResponseIsValid = true;
                                                            this.successful_validation();
                                                        } else {
                                                            this.oidcSecurityCommon.logWarning('authorizedCallback incorrect at_hash');
                                                        }
                                                    } else {
                                                        authResponseIsValid = true;
                                                        this.successful_validation();
                                                    }
                                                } else {
                                                    this.oidcSecurityCommon.logWarning('authorizedCallback token expired');
                                                }
                                            } else {
                                                this.oidcSecurityCommon.logWarning('authorizedCallback incorrect aud');
                                            }
                                        } else {
                                            this.oidcSecurityCommon.logWarning('authorizedCallback incorrect iss does not match authWellKnownEndpoints issuer');
                                        }
                                    } else {
                                        this.oidcSecurityCommon.logWarning('authorizedCallback Validation, iat rejected id_token was issued too far away from the current time');
                                    }
                                } else {
                                    this.oidcSecurityCommon.logDebug('authorizedCallback Validation, one of the REQUIRED properties missing from id_token');
                                }
                            } else {
                                this.oidcSecurityCommon.logWarning('authorizedCallback incorrect nonce');
                            }
                        } else {
                            this.oidcSecurityCommon.logDebug('authorizedCallback Signature validation failed id_token');
                        }
                    } else {
                        this.oidcSecurityCommon.logWarning('authorizedCallback incorrect state');
                    }
                }

                this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_silent_renew_running, '');

                if (authResponseIsValid) {
                    this.setAuthorizationData(access_token, id_token);
                    if (this.authConfiguration.auto_userinfo) {
                        this.getUserinfo(isRenewProcess, result, id_token, decoded_id_token).subscribe((response) => {
                            if (response) {
                                this.router.navigate([this.authConfiguration.startup_route]);
                            } else {
                                //this.router.navigate([this.authConfiguration.unauthorized_route]);
                            }
                        });
                    } else {
                        this.router.navigate([this.authConfiguration.startup_route]);
                    }
                } else { // some went wrong
                    this.oidcSecurityCommon.logDebug('authorizedCallback, token(s) validation failed, resetting');
                    this.resetAuthorizationData(false);
                    this.router.navigate([this.authConfiguration.unauthorized_route]);
                }
            });
    }

    refreshSessionCallback(href: any) {
      return new Promise((resolve, reject) => {
        let silentRenew = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_silent_renew_running);
        let isRenewProcess = (silentRenew === 'running');

        this.oidcSecurityCommon.logDebug('BEGIN authorizedCallback, no auth data');
        this.resetAuthorizationData(isRenewProcess);

        console.log(href);

        let hash = href;

        console.log(hash);

        let result: any = hash.split('&').reduce(function (result: any, item: string) {
            let parts = item.split('=');
            result[parts[0]] = parts[1];
            return result;
        }, {});

        console.log(result);

        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_result, result);

        this.oidcSecurityCommon.logDebug(result);
        this.oidcSecurityCommon.logDebug('authorizedCallback created, begin token validation');

        let access_token = '';
        let id_token = '';
        let authResponseIsValid = false;
        let decoded_id_token: any;

        this.getSigningKeys()
            .subscribe(jwtKeys => {
                this.jwtKeys = jwtKeys;

                if (!result.error) {

                    // validate state
                    if (this.oidcSecurityValidation.validateStateFromHashCallback(result.state, this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_state_control))) {
                        if (this.authConfiguration.response_type === 'id_token token') {
                            access_token = result.access_token;
                        }
                        id_token = result.id_token;

                        let headerDecoded;
                        decoded_id_token = this.oidcSecurityValidation.getPayloadFromToken(id_token, false);
                        headerDecoded = this.oidcSecurityValidation.getHeaderFromToken(id_token, false);

                        // validate jwt signature
                        if (this.oidcSecurityValidation.validate_signature_id_token(id_token, this.jwtKeys)) {
                            // validate nonce
                            if (this.oidcSecurityValidation.validate_id_token_nonce(decoded_id_token, this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_nonce))) {
                                // validate required fields id_token
                                if (this.oidcSecurityValidation.validate_required_id_token(decoded_id_token)) {
                                    // validate max offset from the id_token issue to now
                                    if (this.oidcSecurityValidation.validate_id_token_iat_max_offset(decoded_id_token, this.authConfiguration.max_id_token_iat_offset_allowed_in_seconds)) {
                                        // validate iss
                                        if (this.oidcSecurityValidation.validate_id_token_iss(decoded_id_token, this.authWellKnownEndpoints.issuer)) {
                                            // validate aud
                                            if (this.oidcSecurityValidation.validate_id_token_aud(decoded_id_token, this.authConfiguration.client_id)) {
                                                // validate_id_token_exp_not_expired
                                                if (this.oidcSecurityValidation.validate_id_token_exp_not_expired(decoded_id_token)) {
                                                    // flow id_token token
                                                    if (this.authConfiguration.response_type === 'id_token token') {
                                                        // valiadate at_hash and access_token
                                                        if (this.oidcSecurityValidation.validate_id_token_at_hash(access_token, decoded_id_token.at_hash) || !access_token) {
                                                            authResponseIsValid = true;
                                                            this.successful_validation();
                                                        } else {
                                                            this.oidcSecurityCommon.logWarning('authorizedCallback incorrect at_hash');

                                                        }
                                                    } else {
                                                        authResponseIsValid = true;
                                                        this.successful_validation();

                                                    }
                                                } else {
                                                    this.oidcSecurityCommon.logWarning('authorizedCallback token expired');

                                                }
                                            } else {
                                                this.oidcSecurityCommon.logWarning('authorizedCallback incorrect aud');

                                            }
                                        } else {
                                            this.oidcSecurityCommon.logWarning('authorizedCallback incorrect iss does not match authWellKnownEndpoints issuer');

                                        }
                                    } else {
                                        this.oidcSecurityCommon.logWarning('authorizedCallback Validation, iat rejected id_token was issued too far away from the current time');

                                    }
                                } else {
                                    this.oidcSecurityCommon.logDebug('authorizedCallback Validation, one of the REQUIRED properties missing from id_token');

                                }
                            } else {
                                this.oidcSecurityCommon.logWarning('authorizedCallback incorrect nonce');

                            }
                        } else {
                            this.oidcSecurityCommon.logDebug('authorizedCallback Signature validation failed id_token');

                        }
                    } else {
                        this.oidcSecurityCommon.logWarning('authorizedCallback incorrect state');

                    }
                }

                this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_silent_renew_running, '');

                if (authResponseIsValid) {
                    this.setAuthorizationData(access_token, id_token);
                    if (this.authConfiguration.auto_userinfo) {
                        this.getUserinfo(isRenewProcess, result, id_token, decoded_id_token).subscribe((response) => {
                            if (response) {
                              resolve();
                                //this.router.navigate([this.authConfiguration.startup_route]);
                            } else {
                              reject();
                                //this.router.navigate([this.authConfiguration.unauthorized_route]);
                            }
                        });
                    } else {
                      reject();
                        //this.router.navigate([this.authConfiguration.startup_route]);
                    }
                } else { // some went wrong
                    this.oidcSecurityCommon.logDebug('authorizedCallback, token(s) validation failed, resetting');
                    this.resetAuthorizationData(false);
                    reject();
                    //this.router.navigate([this.authConfiguration.unauthorized_route]);
                }
            });
      });
    }

    getUserinfo(isRenewProcess = false, result?: any, id_token?: any, decoded_id_token?: any): Observable<boolean> {
        result = result ? result : this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_result);
        id_token = id_token ? id_token : this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_id_token);
        decoded_id_token = decoded_id_token ? decoded_id_token : this.oidcSecurityValidation.getPayloadFromToken(id_token, false);

        return new Observable<boolean>(observer => {
            // flow id_token token
            if (this.authConfiguration.response_type === 'id_token token') {
                if (isRenewProcess) {
                    this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_session_state, result.session_state);
                    observer.next(true);
                    observer.complete();
                } else {
                    this.oidcSecurityUserService.initUserData()
                        .subscribe(() => {
                            this.oidcSecurityCommon.logDebug('authorizedCallback id_token token flow');
                            if (this.oidcSecurityValidation.validate_userdata_sub_id_token(decoded_id_token.sub, this.oidcSecurityUserService.userData.sub)) {
                                this.setUserData(this.oidcSecurityUserService.userData);
                                this.oidcSecurityCommon.logDebug(this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_access_token));
                                this.oidcSecurityCommon.logDebug(this.oidcSecurityUserService.userData);

                                this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_session_state, result.session_state);

                                this.runTokenValidatation();
                                observer.next(true);
                            } else { // some went wrong, userdata sub does not match that from id_token
                                this.oidcSecurityCommon.logWarning('authorizedCallback, User data sub does not match sub in id_token');
                                this.oidcSecurityCommon.logDebug('authorizedCallback, token(s) validation failed, resetting');
                                this.resetAuthorizationData(false);
                                observer.next(false);
                            }
                            observer.complete();
                        });
                }
            } else { // flow id_token
                this.oidcSecurityCommon.logDebug('authorizedCallback id_token flow');
                this.oidcSecurityCommon.logDebug(this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_access_token));

                // userData is set to the id_token decoded. No access_token.
                this.oidcSecurityUserService.userData = decoded_id_token;
                this.setUserData(this.oidcSecurityUserService.userData);

                this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_session_state, result.session_state);

                if (!isRenewProcess) {
                    this.runTokenValidatation();
                }

                observer.next(true);
                observer.complete();
            }
        });
    }

    logoff() {
        // /connect/endsession?id_token_hint=...&post_logout_redirect_uri=https://myapp.com
        this.oidcSecurityCommon.logDebug('BEGIN Authorize, no auth data');

        if (this.authWellKnownEndpoints.end_session_endpoint) {
            let authorizationEndsessionUrl = this.authWellKnownEndpoints.end_session_endpoint;

            let id_token_hint = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_id_token);
            let post_logout_redirect_uri = this.authConfiguration.post_logout_redirect_uri;

            let url =
                authorizationEndsessionUrl + '?' +
                'id_token_hint=' + encodeURI(id_token_hint) + '&' +
                'post_logout_redirect_uri=' + encodeURI(post_logout_redirect_uri);

            this.resetAuthorizationData(false);

            if (this.authConfiguration.start_checksession && this.checkSessionChanged) {
                this.oidcSecurityCommon.logDebug('only local login cleaned up, server session has changed');
            } else {
                //this._popupFor = "logout";
                //this.popup(url, 'QPONS\' LOGOUT PAGE', 800, 800);
                return url;
            }
        } else {
            this.resetAuthorizationData(false);
            this.oidcSecurityCommon.logDebug('only local login cleaned up, no end_session_endpoint');
        }
    }

    public successful_validation() {
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_nonce, '');
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_state_control, '');
        this.oidcSecurityCommon.logDebug('AuthorizedCallback token(s) validated, continue');
    }

    private refreshSession() {
        this.oidcSecurityCommon.logDebug('BEGIN refresh session Authorize');

        let nonce = 'N' + Math.random() + '' + Date.now();
        let state = Date.now() + '' + Math.random();

        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_state_control, state);
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_auth_nonce, nonce);
        this.oidcSecurityCommon.logDebug('RefreshSession created. adding myautostate: ' + this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_auth_state_control));

        let url = this.createAuthorizeUrl(nonce, state, this.authWellKnownEndpoints.authorization_endpoint);

        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_silent_renew_running, 'running');
        this.oidcSecuritySilentRenew.startRenew(url);
    }

    public setAuthorizationData(access_token: any, id_token: any) {
        if (this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_access_token) !== '') {
            this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_access_token, '');
        }

        this.oidcSecurityCommon.logDebug(access_token);
        this.oidcSecurityCommon.logDebug(id_token);
        this.oidcSecurityCommon.logDebug('storing to storage, getting the roles');
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_access_token, access_token);
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_id_token, id_token);
        this.setIsAuthorized(true);
        this.oidcSecurityCommon.store(this.oidcSecurityCommon.storage_is_authorized, true);
    }

    private createAuthorizeUrl(nonce: string, state: string, authorization_endpoint: string): string {

        let urlParts = authorization_endpoint.split('?');
        let authorizationUrl = urlParts[0];
        let params = new URLSearchParams(urlParts[1]);
        params.set('client_id', this.authConfiguration.client_id);
        params.set('redirect_uri', this.authConfiguration.redirect_url);
        params.set('response_type', this.authConfiguration.response_type);
        params.set('scope', this.authConfiguration.scope);
        params.set('nonce', nonce);
        params.set('state', state);

        let customParams = Object.assign({}, this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_custom_request_params));

        Object.keys(customParams).forEach(key => {
            params.set(key, customParams[key]);
        });

        return `${authorizationUrl}?${params}`;
    }

    private getAuthorizeData(nonce: string, state: string, authorization_endpoint: string): {} {
      return {
        'client_id': this.authConfiguration.client_id,
        'redirect_uri': this.authConfiguration.redirect_url,
        'response_type': this.authConfiguration.response_type,
        'scope': this.authConfiguration.scope,
        'nonce': nonce,
        'state': state
      };
    }

    public resetAuthorizationData(isRenewProcess: boolean) {
        if (!isRenewProcess) {
            this.setIsAuthorized(false);
            this.oidcSecurityCommon.resetStorageData(isRenewProcess);
            this.checkSessionChanged = false;
        }
    }

    handleError(error: any) {
        this.oidcSecurityCommon.logError(error);
        if (error.status == 403) {
            this.router.navigate([this.authConfiguration.forbidden_route]);
        } else if (error.status == 401) {
            let silentRenew = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_silent_renew_running);
            this.resetAuthorizationData(silentRenew);
            this.router.navigate([this.authConfiguration.unauthorized_route]);
        }
    }

    private onCheckSessionChanged() {
        this.oidcSecurityCommon.logDebug('onCheckSessionChanged');
        this.checkSessionChanged = true;
    }

    private onWellKnownEndpointsLoaded() {
        this.oidcSecurityCommon.logDebug('onWellKnownEndpointsLoaded');
        this.authWellKnownEndpointsLoaded = true;
    }

    private runGetSigningKeys() {
        this.getSigningKeys()
            .subscribe(
            jwtKeys => this.jwtKeys = jwtKeys,
            error => this.errorMessage = <any>error);
    }

    public getSigningKeys(): Observable<JwtKeys> {
        this.oidcSecurityCommon.logDebug('jwks_uri: ' + this.authWellKnownEndpoints.jwks_uri);
        return this.http.get(this.authWellKnownEndpoints.jwks_uri)
            .map(this.extractData)
            .catch(this.handleErrorGetSigningKeys);
    }

    private extractData(res: Response) {
        let body = res.json();
        return body;
    }

    private handleErrorGetSigningKeys(error: Response | any) {
        let errMsg: string;
        if (error instanceof Response) {
            const body = error.json() || {};
            const err = body.error || JSON.stringify(body);
            errMsg = `${error.status} - ${error.statusText || ''} ${err}`;
        } else {
            errMsg = error.message ? error.message : error.toString();
        }
        console.error(errMsg);
        return Observable.throw(errMsg);
    }

    private runTokenValidatation() {
        let source = Observable.timer(3000, 3000)
            .timeInterval()
            .pluck('interval')
            .take(10000);

        let subscription = source.subscribe(() => {
            if (this._isAuthorizedValue) {
                let token = this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_id_token);
                if(token != "" && token != undefined && token != null) {
                    if (this.oidcSecurityValidation.isTokenExpired(this.oidcSecurityCommon.retrieve(this.oidcSecurityCommon.storage_id_token))) {
                        this.oidcSecurityCommon.logDebug('IsAuthorized: id_token isTokenExpired, start silent renew if active');
                        if (this.authConfiguration.silent_renew) {
                            this.refreshSession();
                        } else {
                            this.resetAuthorizationData(false);
                        }
                    }
                } else {
                    this.resetAuthorizationData(false);
                }
            }
        },
            (err: any) => {
                this.oidcSecurityCommon.logError('Error: ' + err);
            },
            () => {
                this.oidcSecurityCommon.logDebug('Completed');
            });
    }
}
