import Foundation

public struct DesktopUpdateApproval {
  public static let signingDomain = "ashlr:desktop-update-approval:v1\u{0}"

  public let transaction: String
  public let releaseDigest: String
  public let grant: ValidatedGrant
  public let expiresAt: Date
  private let canonical: String

  public init(data: Data, context: GrantValidationContext) throws {
    let value = try StrictJSONParser.parse(data)
    let keys: Set<String> = ["transaction", "releaseDigest", "surfaceDigest", "expiresAtMs", "grant"]
    guard let members = value.objectMembers, Set(members.map(\.key)) == keys,
          let transaction = value["transaction"]?.stringValue, Self.hex(transaction, count: 32),
          let releaseDigest = value["releaseDigest"]?.stringValue, Self.hex(releaseDigest, count: 64),
          let surface = value["surfaceDigest"]?.stringValue, Self.hex(surface, count: 64),
          let expiry = value["expiresAtMs"]?.integerValue, expiry > 0, expiry <= GrantContract.maxSafeInteger,
          let payload = value["grant"] else {
      throw GrantRefusal(path: "approval", reason: "invalid desktop update approval")
    }
    let grant = try StandingGrantValidator.validate(payload, context: context)
    let expiresAt = Date(timeIntervalSince1970: Double(expiry) / 1000)
    guard expiresAt > context.now, expiresAt <= grant.expiresAtDate, surface == grant.authoritySurfaceDigest else {
      throw GrantRefusal(path: "approval", reason: "expired approval or candidate surface mismatch")
    }
    self.transaction = transaction
    self.releaseDigest = releaseDigest
    self.grant = grant
    self.expiresAt = expiresAt
    self.canonical = try CanonicalJSON.encode(value)
  }

  private static func hex(_ value: String, count: Int) -> Bool {
    value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }

  public var message: Data { Data((Self.signingDomain + canonical).utf8) }

  public var prompt: GrantPrompt {
    let update = "install verified Phantom update \(releaseDigest.prefix(12)) (transaction \(transaction.prefix(12))) and "
    let grantPrompt = GrantPromptRenderer.render(grant, prefix: update)
    return GrantPrompt(reason: grantPrompt.reason,
      fullScope: "Phantom update transaction \(transaction)\n  release     \(releaseDigest)\n  expires     \(GrantPromptRenderer.humanInstant(expiresAt))\n" + grantPrompt.fullScope)
  }

  public func envelope(grantSignature: Data, approvalSignature: Data) throws -> String {
    guard approvalSignature.count == 64 else {
      throw GrantRefusal(path: "approvalSignature", reason: "an ES256 signature is 64 bytes (r‖s)")
    }
    let signed = try GrantSigning.envelope(for: grant, signatureP1363: grantSignature)
    return "{\"approvalSignature\":\"\(approvalSignature.base64EncodedString())\",\"grant\":\(signed)}"
  }
}
