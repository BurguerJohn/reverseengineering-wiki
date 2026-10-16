<?php
/**
 * Email-code login for the wiki (design/08-accounts-and-auth.md#web-login).
 *
 * Step 1: the login form asks only for an email address. MediaWiki asks the gateway
 * (the only email sender, and the only place that knows operators' addresses) to send a
 * one-time code; the page always answers "if an account uses this address, a code was
 * sent", so nobody can probe which addresses are registered.
 * Step 2: the person types the code; the gateway checks it and names the account, and
 * MediaWiki logs that account in. Codes are bound to this login attempt (nonce kept in
 * the session), expire in 10 minutes and allow 5 tries; the gateway limits how many
 * different accounts one connection may try.
 *
 * Password login stays available for staff accounts at Special:UserLogin?passwordlogin=1
 * (operator accounts have random passwords nobody knows).
 */

use MediaWiki\Auth\AbstractPrimaryAuthenticationProvider;
use MediaWiki\Auth\AuthenticationRequest;
use MediaWiki\Auth\AuthenticationResponse;
use MediaWiki\Auth\AuthManager;
use MediaWiki\MediaWikiServices;

class REWikiEmailRequest extends AuthenticationRequest {
	/** @var string|null */
	public $email;

	public function getFieldInfo() {
		return [
			'email' => [
				'type' => 'string',
				'label' => wfMessage( 'rewiki-login-email' ),
				'help' => wfMessage( 'rewiki-login-email-help' ),
			],
		];
	}
}

class REWikiCodeRequest extends AuthenticationRequest {
	/** @var string|null */
	public $code;

	public function getFieldInfo() {
		return [
			'code' => [
				'type' => 'string',
				'label' => wfMessage( 'rewiki-login-code' ),
				'help' => wfMessage( 'rewiki-login-code-help' ),
			],
		];
	}
}

class REWikiEmailCodeProvider extends AbstractPrimaryAuthenticationProvider {
	private const STATE = 'REWikiEmailCode';
	private const MAX_TRIES = 5;

	public function getAuthenticationRequests( $action, array $options ) {
		return $action === AuthManager::ACTION_LOGIN ? [ new REWikiEmailRequest() ] : [];
	}

	public function beginPrimaryAuthentication( array $reqs ) {
		$req = AuthenticationRequest::getRequestByClass( $reqs, REWikiEmailRequest::class );
		$email = trim( (string)( $req->email ?? '' ) );
		if ( !$req || $email === '' ) {
			return AuthenticationResponse::newAbstain();
		}
		if ( !preg_match( '/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/', $email ) ) {
			return AuthenticationResponse::newFail( wfMessage( 'rewiki-login-invalid-email' ) );
		}
		$nonce = bin2hex( random_bytes( 32 ) );
		$answer = self::gateway( '/auth/web/start', [
			'email' => $email,
			'client_nonce_hash' => hash( 'sha256', $nonce ),
			'ip' => $this->manager->getRequest()->getIP(),
		] );
		if ( !$answer['ok'] ) {
			return AuthenticationResponse::newFail( wfMessage(
				$answer['error'] === 'RATE_LIMITED' ? 'rewiki-login-ratelimited' : 'rewiki-login-unavailable'
			) );
		}
		$this->manager->setAuthenticationSessionData( self::STATE, [
			'challenge' => $answer['body']['challenge_id'] ?? '',
			'nonce' => $nonce,
			'tries' => 0,
		] );
		// Same answer for every address: registered or not, the next step looks identical.
		return AuthenticationResponse::newUI( [ new REWikiCodeRequest() ], wfMessage( 'rewiki-login-code-sent' ), 'warning' );
	}

	public function continuePrimaryAuthentication( array $reqs ) {
		$state = $this->manager->getAuthenticationSessionData( self::STATE );
		if ( !is_array( $state ) ) {
			return AuthenticationResponse::newFail( wfMessage( 'rewiki-login-expired' ) );
		}
		$req = AuthenticationRequest::getRequestByClass( $reqs, REWikiCodeRequest::class );
		$code = preg_replace( '/\s+/', '', (string)( $req->code ?? '' ) );
		if ( !preg_match( '/^\d{6}$/', $code ) ) {
			return AuthenticationResponse::newUI( [ new REWikiCodeRequest() ], wfMessage( 'rewiki-login-code-format' ), 'error' );
		}
		$answer = self::gateway( '/auth/web/verify', [
			'challenge_id' => $state['challenge'],
			'code' => $code,
			'client_nonce' => $state['nonce'],
		] );
		if ( $answer['ok'] && isset( $answer['body']['username'] ) ) {
			$this->manager->removeAuthenticationSessionData( self::STATE );
			return AuthenticationResponse::newPass( (string)$answer['body']['username'] );
		}
		$state['tries']++;
		if ( $state['tries'] >= self::MAX_TRIES || $answer['error'] !== 'INVALID_CODE' ) {
			$this->manager->removeAuthenticationSessionData( self::STATE );
			return AuthenticationResponse::newFail( wfMessage( 'rewiki-login-expired' ) );
		}
		$this->manager->setAuthenticationSessionData( self::STATE, $state );
		return AuthenticationResponse::newUI( [ new REWikiCodeRequest() ], wfMessage( 'rewiki-login-code-wrong' ), 'error' );
	}

	public function testUserExists( $username, $flags = 0 ) {
		return false;
	}

	public function providerAllowsAuthenticationDataChange( AuthenticationRequest $req, $checkData = true ) {
		return StatusValue::newGood( 'ignored' );
	}

	public function providerChangeAuthenticationData( AuthenticationRequest $req ) {
	}

	public function accountCreationType() {
		return self::TYPE_NONE;
	}

	public function beginPrimaryAccountCreation( $user, $creator, array $reqs ) {
		return AuthenticationResponse::newAbstain();
	}

	/**
	 * Server-to-server call to the gateway on its private address.
	 * @return array{ok: bool, error: ?string, body: array}
	 */
	private static function gateway( string $path, array $payload ): array {
		global $wgREWikiGatewayInternalUrl, $wgREWikiWebLoginSecret;
		$http = MediaWikiServices::getInstance()->getHttpRequestFactory()->create(
			rtrim( $wgREWikiGatewayInternalUrl, '/' ) . $path,
			[ 'method' => 'POST', 'postData' => json_encode( $payload ), 'timeout' => 15 ],
			__METHOD__
		);
		$http->setHeader( 'Content-Type', 'application/json' );
		$http->setHeader( 'X-REWiki-Web-Secret', (string)$wgREWikiWebLoginSecret );
		$status = $http->execute();
		$body = json_decode( (string)$http->getContent(), true );
		$body = is_array( $body ) ? $body : [];
		if ( $status->isOK() && $http->getStatus() === 200 ) {
			return [ 'ok' => true, 'error' => null, 'body' => $body ];
		}
		return [ 'ok' => false, 'error' => $body['error'] ?? 'UNAVAILABLE', 'body' => $body ];
	}
}
