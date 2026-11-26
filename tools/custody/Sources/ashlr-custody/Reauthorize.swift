// Operator-only ACL repair for a single existing legacy Keychain item.
// No stored credential data is read, exported, replaced, or recreated.
import CustodyCore
import CustodySecurity
import Darwin
import Foundation
import Security

enum ExistingSecretReauthorization {
  static let installedPath = "/usr/local/libexec/ashlr-custody"

  struct ImageIdentity: Equatable {
    let device: dev_t
    let inode: ino_t
    let codeDirectory: Data
  }

  static func refuse(_ code: String = "reauthorization-refused") -> CustodyFailure {
    CustodyFailure(code, "cannot safely reauthorize this existing item; nothing was changed", exit: .refused)
  }

  static func requireOperator() throws {
    let environment = ProcessInfo.processInfo.environment
    let loginHome = getpwuid(getuid()).flatMap { $0.pointee.pw_dir }.map { String(cString: $0) }
    let home = environment["HOME"]
    let matches = loginHome != nil && home != nil &&
      URL(fileURLWithPath: home!).standardizedFileURL.path == URL(fileURLWithPath: loginHome!).standardizedFileURL.path
    try ReauthorizationOperatorContext(
      stdinTTY: isatty(STDIN_FILENO) == 1, stdoutTTY: isatty(STDOUT_FILENO) == 1,
      loginHomeMatches: matches, uid: getuid(), effectiveUID: geteuid(), environment: environment
    ).requireOperator()
  }

  static func installedIdentity() throws -> ImageIdentity {
    // PROC_PIDPATHINFO_MAXSIZE is 4 * MAXPATHLEN; its C macro is not
    // imported by Swift because MAXPATHLEN expands through sizeof.
    var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(getpid(), &path, UInt32(path.count)) > 0,
          String(cString: path) == installedPath else { throw refuse("installed-helper-required") }
    for directory in ["/", "/usr", "/usr/local", "/usr/local/libexec"] {
      var st = stat()
      guard lstat(directory, &st) == 0, st.st_mode & S_IFMT == S_IFDIR,
            st.st_uid == 0, st.st_mode & 0o022 == 0 else { throw refuse("unsafe-helper-path") }
    }
    var before = stat()
    guard lstat(installedPath, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
          before.st_uid == 0, before.st_gid == 0, before.st_mode & 0o7777 == 0o755,
          before.st_nlink == 1 else { throw refuse("unsafe-helper-path") }
    var running: SecCode?
    var disk: SecStaticCode?
    guard SecCodeCopySelf([], &running) == errSecSuccess, let running,
          SecStaticCodeCreateWithPath(URL(fileURLWithPath: installedPath) as CFURL, [], &disk) == errSecSuccess, let disk,
          SecCodeCheckValidity(running, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
          SecStaticCodeCheckValidity(disk, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else {
      throw refuse("invalid-helper-signature")
    }
    func signingInfo(_ code: SecStaticCode) throws -> NSDictionary {
      var information: CFDictionary?
      guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
            let information else { throw refuse("invalid-helper-signature") }
      return information as NSDictionary
    }
    let diskInfo = try signingInfo(disk)
    guard let diskHash = diskInfo[kSecCodeInfoUnique] as? Data, diskHash.count == 20,
          diskInfo[kSecCodeInfoIdentifier] as? String == "ai.ashlr.custody",
          let flags = diskInfo[kSecCodeInfoFlags] as? NSNumber,
          flags.uint32Value & 0x10000 != 0 else { // SDK kSecCodeSignatureRuntime (not Swift-imported)
      throw refuse("invalid-helper-signature")
    }
    // A static object obtained from a running code's disk path alone does
    // not securely identify its loaded image. Check a CDHash requirement on
    // the DYNAMIC SecCode, not equality between two disk signing-info reads.
    let hex = diskHash.map { String(format: "%02x", $0) }.joined()
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString("identifier \"ai.ashlr.custody\" and cdhash H\"\(hex)\"" as CFString, [], &requirement) == errSecSuccess,
          let requirement,
          SecCodeCheckValidity(running, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else {
      throw refuse("running-helper-mismatch")
    }
    var after = stat()
    guard lstat(installedPath, &after) == 0, before.st_dev == after.st_dev,
          before.st_ino == after.st_ino, before.st_size == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
          before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
          before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else {
      throw refuse("helper-changed")
    }
    return ImageIdentity(device: before.st_dev, inode: before.st_ino, codeDirectory: diskHash)
  }

  static func currentHelperCDHash() throws -> String {
    var running: SecCode?
    guard SecCodeCopySelf([], &running) == errSecSuccess, let running else {
      throw refuse("invalid-helper-signature")
    }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(
      running, SecCSFlags(rawValue: kSecCSSigningInformation), &information
    ) == errSecSuccess,
          let information,
          let hash = (information as NSDictionary)[kSecCodeInfoUnique] as? Data,
          hash.count == 20 else {
      throw refuse("invalid-helper-signature")
    }
    return hash.map { String(format: "%02x", $0) }.joined()
  }

  /// Explicitly select file-based, non-synchronizable generic passwords.
  /// match-all covers the default legacy search list: no first-match repair.
  static func items(_ account: ReauthorizationAccount) throws -> [SecKeychainItem] {
    guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw refuse() }
    let query = CustodyLegacySecretQuery.references(service: SecretStore.service, account: account.rawValue)
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let refs = result as? [SecKeychainItem],
          refs.allSatisfy({ CFGetTypeID($0) == SecKeychainItemGetTypeID() }) else { throw refuse() }
    return refs
  }

  static func access(_ item: SecKeychainItem) throws -> CustodyLegacyAccess.PreparedAccess {
    var access: SecAccess?
    var trusted: SecTrustedApplication?
    guard SecKeychainItemCopyAccess(item, &access) == errSecSuccess, let access,
          SecTrustedApplicationCreateFromPath(nil, &trusted) == errSecSuccess, let trusted else { throw refuse() }
    return try CustodyLegacyAccess.prepare(access, trusted: trusted, helperCDHash: currentHelperCDHash())
  }

  static func applyAccess(_ item: SecKeychainItem, prepared: CustodyLegacyAccess.PreparedAccess) throws {
    guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { throw refuse() }

    var password = [CChar](repeating: 0, count: 1024)
    defer {
      password.withUnsafeMutableBufferPointer { buffer in
        if let base = buffer.baseAddress {
          explicit_bzero(UnsafeMutableRawPointer(base), buffer.count)
        }
      }
    }
    let entered = "Login keychain password: ".withCString { prompt in
      password.withUnsafeMutableBufferPointer { buffer in
        guard let base = buffer.baseAddress else { return nil }
        return readpassphrase(prompt, base, buffer.count, RPP_REQUIRE_TTY)
      }
    }
    guard entered != nil else {
      throw CustodyFailure("keychain-password-unavailable", "the login keychain password could not be read; no Keychain item was changed", exit: .auth)
    }
    let status = password.withUnsafeBufferPointer { buffer -> OSStatus in
      guard let base = buffer.baseAddress else { return errSecParam }
      let length = strnlen(base, buffer.count)
      return SecKeychainItemSetAccessWithPassword(
        item, prepared.updated, UnsafeRawPointer(base), UInt32(length)
      )
    }
    guard status == errSecSuccess else {
      throw CustodyFailure("keychain-authorization-failed", "the OS did not authorize this item's access change", exit: .keystore)
    }
  }

  static func run(_ account: ReauthorizationAccount) throws {
    try Reauthorization.perform(
      account: account, requireOperator: requireOperator, installedIdentity: installedIdentity,
      findItems: { try items(account) }, sameItem: { CFEqual($0, $1) }, prepareAccess: access,
      authenticate: { reason in
        do { _ = try Presence.authenticate(reason: reason) }
        catch let failure as CustodyFailure {
          throw CustodyFailure(failure.code, "human authentication did not complete; no Keychain item was changed", exit: .auth)
        }
      },
      requireUnchangedAccess: { item, prepared in
        var current: SecAccess?
        guard SecKeychainItemCopyAccess(item, &current) == errSecSuccess, let current,
              try CustodyLegacyAccess.snapshot(current) == prepared.original else { throw refuse("access-changed") }
      },
      applyAccess: { item, access in
        try applyAccess(item, prepared: access)
      },
      verifyAppliedAccess: { item, prepared in
        var actual: SecAccess?
        guard SecKeychainItemCopyAccess(item, &actual) == errSecSuccess, let actual,
              try CustodyLegacyAccess.snapshot(actual) == prepared.expected else { throw refuse() }
      }
    )
    IO.out(Reauthorization.successJSON(account: account))
  }
}
