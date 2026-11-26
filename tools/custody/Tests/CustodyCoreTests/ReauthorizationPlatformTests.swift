// Real SDK objects, exclusively in memory. No Keychain item/query/data APIs,
// user authentication, network, signing or installed-helper mutation.
import XCTest
import Foundation
import Security
import CustodyCore
@testable import CustodySecurity

final class ReauthorizationPlatformTests: XCTestCase {
  let helperCDHash = String(repeating: "a", count: 40)

  func fixture() throws -> (SecAccess, SecTrustedApplication) {
    var old: SecTrustedApplication?
    var current: SecTrustedApplication?
    var access: SecAccess?
    XCTAssertEqual(SecTrustedApplicationCreateFromPath("/usr/bin/true", &old), errSecSuccess)
    XCTAssertEqual(SecTrustedApplicationCreateFromPath(nil, &current), errSecSuccess)
    let oldApp = try XCTUnwrap(old)
    XCTAssertEqual(SecAccessCreate("Synthetic in-memory ACL" as CFString, [oldApp] as CFArray, &access), errSecSuccess)
    let result = try XCTUnwrap(access)
    let currentApp = try XCTUnwrap(current)
    let partitions = [
      "cdhash:\(String(repeating: "5", count: 40))",
      "teamid:TEAMID1234",
      "apple-tool:",
    ]
    var all: CFArray?
    XCTAssertEqual(SecAccessCopyACLList(result, &all), errSecSuccess)
    let partitionACLs = try XCTUnwrap(all as? [SecACL]).filter {
      (SecACLCopyAuthorizations($0) as? [String]) == [CustodyLegacyAccess.partitionIDAuthorization]
    }
    if let existing = partitionACLs.first {
      try setPartitionACLContents(existing, partitions: partitions)
    } else {
      try addPartitionACL(result, trusted: currentApp, partitions: partitions)
    }
    XCTAssertLessThanOrEqual(partitionACLs.count, 1)
    return (result, currentApp)
  }

  func partitionDescription(_ partitions: [String]) throws -> String {
    let data = try PropertyListSerialization.data(
      fromPropertyList: ["Partitions": partitions],
      format: .xml,
      options: 0
    )
    return try XCTUnwrap(String(data: data, encoding: .utf8))
  }

  func setPartitionACLContents(_ acl: SecACL, partitions: [String]) throws {
    let description = try partitionDescription(partitions)
    var applications: CFArray?
    var existingDescription: CFString?
    var prompt = SecKeychainPromptSelector()
    XCTAssertEqual(SecACLCopyContents(acl, &applications, &existingDescription, &prompt), errSecSuccess)
    XCTAssertEqual(SecACLSetContents(acl, applications, description as CFString, prompt), errSecSuccess)
  }

  func addPartitionACL(_ access: SecAccess, trusted: SecTrustedApplication, partitions: [String]) throws {
    let description = try partitionDescription(partitions)
    var acl: SecACL?
    XCTAssertEqual(SecACLCreateWithSimpleContents(access, [trusted] as CFArray, description as CFString, [], &acl), errSecSuccess)
    let partitionACL = try XCTUnwrap(acl)
    XCTAssertEqual(SecACLUpdateAuthorizations(
      partitionACL, [CustodyLegacyAccess.partitionIDAuthorization] as CFArray
    ), errSecSuccess)
    try setPartitionACLContents(partitionACL, partitions: partitions)
  }

  func decryptACL(_ access: SecAccess) throws -> SecACL {
    var all: CFArray?
    XCTAssertEqual(SecAccessCopyACLList(access, &all), errSecSuccess)
    let acls = try XCTUnwrap(all as? [SecACL])
    XCTAssertTrue(acls.allSatisfy { CFGetTypeID($0) == SecACLGetTypeID() })
    return try XCTUnwrap(acls.first { acl in
      (SecACLCopyAuthorizations(acl) as? [String])?.contains(kSecACLAuthorizationDecrypt as String) == true
    })
  }

  func testDefaultSDKAccessPreparesAndReadsBackWithoutChangingOtherRules() throws {
    let (access, current) = try fixture()
    let before = try CustodyLegacyAccess.snapshot(access)
    let targetIndices = before.acls.indices.filter { before.acls[$0].authorizations.contains(kSecACLAuthorizationDecrypt as String) }
    let partitionIndices = before.acls.indices.filter {
      before.acls[$0].authorizations == [CustodyLegacyAccess.partitionIDAuthorization]
    }
    XCTAssertEqual(targetIndices.count, 1)
    XCTAssertEqual(partitionIndices.count, 1)
    let target = before.acls[try XCTUnwrap(targetIndices.first)]
    let partitionIndex = try XCTUnwrap(partitionIndices.first)
    let expectedPartitionDescription = try CustodyLegacyAccess.rewritePartitionDescription(
      [before.acls[partitionIndex].description], helperCDHash: helperCDHash
    )
    XCTAssertEqual(Set(target.authorizations), Set(Reauthorization.legacyDecryptAuthorizations))
    XCTAssertEqual(target.authorizations.count, 6)
    XCTAssertEqual(target.applications?.count, 1)
    let prepared = try CustodyLegacyAccess.prepare(access, trusted: current, helperCDHash: helperCDHash)
    XCTAssertEqual(prepared.original, before)
    let after = try CustodyLegacyAccess.snapshot(prepared.updated)
    XCTAssertEqual(after, prepared.expected)
    XCTAssertEqual(after.owner, before.owner)
    XCTAssertEqual(after.group, before.group)
    XCTAssertEqual(after.ownerType, before.ownerType)
    XCTAssertEqual(after.acls.count, before.acls.count)
    var currentData: CFData?
    XCTAssertEqual(SecTrustedApplicationCopyData(current, &currentData), errSecSuccess)
    let trustedBytes = try XCTUnwrap(currentData) as Data
    for i in before.acls.indices {
      if targetIndices.contains(i) {
        XCTAssertEqual(after.acls[i].applications, [trustedBytes])
        XCTAssertNotEqual(after.acls[i].applications, before.acls[i].applications)
        XCTAssertEqual(after.acls[i].description, before.acls[i].description)
        XCTAssertEqual(after.acls[i].prompt, before.acls[i].prompt)
        XCTAssertEqual(after.acls[i].authorizations, before.acls[i].authorizations)
      } else if i == partitionIndex {
        XCTAssertEqual(after.acls[i].description, expectedPartitionDescription)
        XCTAssertEqual(after.acls[i].applications, before.acls[i].applications)
        XCTAssertEqual(after.acls[i].prompt, before.acls[i].prompt)
        XCTAssertEqual(after.acls[i].authorizations, before.acls[i].authorizations)
      } else {
        XCTAssertEqual(after.acls[i], before.acls[i])
      }
    }
  }

  func testBroadDefaultDecryptApplicationListIsRefusedInMemory() throws {
    let (access, current) = try fixture()
    let acl = try decryptACL(access)
    var applications: CFArray?
    var description: CFString?
    var prompt = SecKeychainPromptSelector()
    XCTAssertEqual(SecACLCopyContents(acl, &applications, &description, &prompt), errSecSuccess)
    XCTAssertEqual(SecACLSetContents(acl, nil, try XCTUnwrap(description), prompt), errSecSuccess)
    XCTAssertThrowsError(try CustodyLegacyAccess.prepare(access, trusted: current, helperCDHash: helperCDHash))
  }

  func testAnyAndControlMixedWithDecryptAreRefusedInMemory() throws {
    for tags in [[kSecACLAuthorizationAny], [kSecACLAuthorizationDecrypt, kSecACLAuthorizationChangeACL]] {
      let (access, current) = try fixture()
      XCTAssertEqual(SecACLUpdateAuthorizations(try decryptACL(access), tags as CFArray), errSecSuccess)
      XCTAssertThrowsError(try CustodyLegacyAccess.prepare(access, trusted: current, helperCDHash: helperCDHash))
    }
  }

  func testMultipleDecryptACLsAreRefusedRatherThanMergingDistinctGrants() throws {
    let (access, current) = try fixture()
    var added: SecACL?
    XCTAssertEqual(SecACLCreateWithSimpleContents(access, [current] as CFArray,
      "Synthetic second decrypt rule" as CFString, [], &added), errSecSuccess)
    XCTAssertEqual(SecACLUpdateAuthorizations(try XCTUnwrap(added), [kSecACLAuthorizationDecrypt] as CFArray), errSecSuccess)
    XCTAssertThrowsError(try CustodyLegacyAccess.prepare(access, trusted: current, helperCDHash: helperCDHash))
  }

  func testMultiplePartitionACLsAreRefusedInMemory() throws {
    let (access, current) = try fixture()
    try addPartitionACL(access, trusted: current, partitions: ["teamid:TEAMID1234"])

    XCTAssertThrowsError(try CustodyLegacyAccess.prepare(access, trusted: current, helperCDHash: helperCDHash)) { error in
      XCTAssertEqual((error as? CustodyFailure)?.code, "partition-acl-count")
    }
  }
}
