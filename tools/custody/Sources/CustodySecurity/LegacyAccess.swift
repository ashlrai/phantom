// In-memory ACL metadata only. This module never queries, reads, creates,
// deletes or updates a Keychain ITEM and never authenticates a person.
import CustodyCore
import Foundation
import Security

public enum CustodyLegacyAccess {
  static let partitionIDAuthorization = "partition_id"

  static func refuse(_ code: String = "reauthorization-refused") -> CustodyFailure {
    CustodyFailure(code, "cannot safely reauthorize this existing item; nothing was changed", exit: .refused)
  }

  public struct PreparedAccess {
    public let updated: SecAccess
    public let original: AccessSnapshot
    public let expected: AccessSnapshot
  }

  public struct ACLSnapshot: Equatable {
    let applications: [Data]?
    let description: String?
    let prompt: UInt16
    let authorizations: [String]
  }

  public struct AccessSnapshot: Equatable {
    let owner: uid_t
    let group: gid_t
    let ownerType: UInt32
    let acls: [ACLSnapshot]
  }

  public static func snapshot(_ access: SecAccess) throws -> AccessSnapshot {
    var owner: uid_t = 0
    var group: gid_t = 0
    var ownerType = SecAccessOwnerType()
    var all: CFArray?
    guard SecAccessCopyOwnerAndACL(access, &owner, &group, &ownerType, nil) == errSecSuccess,
          SecAccessCopyACLList(access, &all) == errSecSuccess,
          let acls = all as? [SecACL], acls.allSatisfy({ CFGetTypeID($0) == SecACLGetTypeID() }) else { throw refuse("unsupported-access") }
    let snapshots = try acls.map { acl -> ACLSnapshot in
      var applications: CFArray?
      var description: CFString?
      var prompt = SecKeychainPromptSelector()
      guard SecACLCopyContents(acl, &applications, &description, &prompt) == errSecSuccess,
            let authorizations = SecACLCopyAuthorizations(acl) as? [String] else { throw refuse("unsupported-access") }
      var appData: [Data]? = nil
      if let applications {
        guard let apps = applications as? [SecTrustedApplication],
              apps.allSatisfy({ CFGetTypeID($0) == SecTrustedApplicationGetTypeID() }) else { throw refuse("unsupported-access") }
        appData = try apps.map { app in
          var opaque: CFData?
          guard SecTrustedApplicationCopyData(app, &opaque) == errSecSuccess, let opaque else { throw refuse() }
          // Opaque equality only; these bytes do not establish an app path.
          return opaque as Data
        }
      }
      return ACLSnapshot(applications: appData, description: description.map { $0 as String },
                         prompt: prompt.rawValue, authorizations: authorizations)
    }
    return AccessSnapshot(owner: owner, group: group, ownerType: ownerType, acls: snapshots)
  }

  static func rewritePartitionDescription(_ descriptions: [String?], helperCDHash: String) throws -> String {
    guard descriptions.count == 1 else { throw refuse("partition-acl-count") }
    let hashBytes = Array(helperCDHash.utf8)
    guard hashBytes.count == 40,
          hashBytes.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102) }) else {
      throw refuse("helper-cdhash-invalid")
    }
    guard let description = descriptions[0], let data = description.data(using: .utf8) else {
      throw refuse("partition-list-malformed")
    }

    let value: Any
    do {
      value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    } catch {
      throw refuse("partition-list-malformed")
    }
    guard let dictionary = value as? [String: Any],
          Set(dictionary.keys) == Set(["Partitions"]),
          let partitions = dictionary["Partitions"] as? [String],
          partitions.allSatisfy({ !$0.isEmpty }) else {
      throw refuse("partition-list-shape")
    }

    let current = "cdhash:\(helperCDHash.lowercased())"
    var updated: [String] = []
    var hasCurrent = false
    for partition in partitions {
      guard partition.hasPrefix("cdhash:") else {
        updated.append(partition)
        continue
      }
      guard partition == current, !hasCurrent else { continue }
      updated.append(partition)
      hasCurrent = true
    }
    if !hasCurrent { updated.append(current) }

    let output: Data
    do {
      output = try PropertyListSerialization.data(fromPropertyList: ["Partitions": updated], format: .xml, options: 0)
    } catch {
      throw refuse("partition-list-malformed")
    }
    guard let result = String(data: output, encoding: .utf8) else { throw refuse("partition-list-malformed") }
    return result
  }

  public static func prepare(
    _ access: SecAccess,
    trusted: SecTrustedApplication,
    helperCDHash: String
  ) throws -> PreparedAccess {
    let original = try snapshot(access)
    guard !original.acls.contains(where: { $0.authorizations.contains(kSecACLAuthorizationAny as String) }) else {
      throw refuse("unsupported-access")
    }
    var all: CFArray?
    guard SecAccessCopyACLList(access, &all) == errSecSuccess,
          let acls = all as? [SecACL], acls.allSatisfy({ CFGetTypeID($0) == SecACLGetTypeID() }) else { throw refuse("unsupported-access") }
    guard acls.count == original.acls.count else { throw refuse("unsupported-access") }
    let partitionIndices = original.acls.indices.filter {
      original.acls[$0].authorizations == [Self.partitionIDAuthorization]
    }
    let partitionDescription = try rewritePartitionDescription(
      partitionIndices.map { original.acls[$0].description },
      helperCDHash: helperCDHash
    )
    guard let partitionIndex = partitionIndices.first else { throw refuse("partition-acl-count") }

    let selected = acls.filter { acl in
      (SecACLCopyAuthorizations(acl) as? [String])?.contains(kSecACLAuthorizationDecrypt as String) == true
    }
    guard selected.count == 1 else { throw refuse("unsupported-access") }
    let decryptACL = selected[0]
    var decryptApplications: CFArray?
    var decryptDescription: CFString?
    var decryptPrompt = SecKeychainPromptSelector()
    guard SecACLCopyContents(decryptACL, &decryptApplications, &decryptDescription, &decryptPrompt) == errSecSuccess,
          let decryptAuthorizations = SecACLCopyAuthorizations(decryptACL) as? [String] else { throw refuse("unsupported-access") }
    let decryptTrustedApplications = decryptApplications as? [SecTrustedApplication]
    try Reauthorization.requireDecryptLayout(
      authorizations: decryptAuthorizations,
      decrypt: kSecACLAuthorizationDecrypt as String,
      applicationCount: decryptTrustedApplications?.count,
      hasDescription: decryptDescription != nil
    )
    guard let decryptDescription else { throw refuse("unsupported-access") }

    let partitionACL = acls[partitionIndex]
    var partitionApplications: CFArray?
    var originalPartitionDescription: CFString?
    var partitionPrompt = SecKeychainPromptSelector()
    guard SecACLCopyContents(partitionACL, &partitionApplications, &originalPartitionDescription, &partitionPrompt) == errSecSuccess,
          (SecACLCopyAuthorizations(partitionACL) as? [String]) == [Self.partitionIDAuthorization],
          let originalPartitionDescription,
          (originalPartitionDescription as String) == original.acls[partitionIndex].description else {
      throw refuse("unsupported-access")
    }
    guard SecACLSetContents(partitionACL, partitionApplications, partitionDescription as CFString, partitionPrompt) == errSecSuccess,
          SecACLSetContents(decryptACL, [trusted] as CFArray, decryptDescription, decryptPrompt) == errSecSuccess else {
      throw refuse()
    }
    // All ACL authorizations, prompts and untouched descriptions remain copied.
    return PreparedAccess(updated: access, original: original, expected: try snapshot(access))
  }

}
