import Foundation
import XCTest
import CustodyCore
@testable import CustodySecurity

final class PartitionListTests: XCTestCase {
  private let helperCDHash = String(repeating: "a", count: 40)

  private func plist(_ partitions: [String]) throws -> String {
    let data = try PropertyListSerialization.data(fromPropertyList: ["Partitions": partitions], format: .xml, options: 0)
    return try XCTUnwrap(String(data: data, encoding: .utf8))
  }

  private func partitions(_ description: String) throws -> [String] {
    let data = try XCTUnwrap(description.data(using: .utf8))
    let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    let dictionary = try XCTUnwrap(value as? [String: [String]])
    return try XCTUnwrap(dictionary["Partitions"])
  }

  func testStaleCDHashIsReplacedAndOtherPartitionsAreKept() throws {
    let input = try plist([
      "cdhash:\(String(repeating: "5", count: 40))",
      "teamid:TEAMID1234",
      "apple-tool:",
      "apple:",
    ])

    let result = try CustodyLegacyAccess.rewritePartitionDescription([input], helperCDHash: helperCDHash)

    XCTAssertEqual(try partitions(result), [
      "teamid:TEAMID1234",
      "apple-tool:",
      "apple:",
      "cdhash:\(helperCDHash)",
    ])
  }

  func testDuplicateOrMissingPartitionACLIsRefused() throws {
    let input = try plist(["teamid:TEAMID1234"])
    let cases: [[String?]] = [[], [input, input]]
    for descriptions in cases {
      XCTAssertThrowsError(try CustodyLegacyAccess.rewritePartitionDescription(
        descriptions, helperCDHash: helperCDHash
      )) { error in
        XCTAssertEqual((error as? CustodyFailure)?.code, "partition-acl-count")
      }
    }
  }

  func testMalformedPartitionPlistIsRefused() {
    XCTAssertThrowsError(try CustodyLegacyAccess.rewritePartitionDescription(
      ["not a property list"], helperCDHash: helperCDHash
    )) { error in
      XCTAssertEqual((error as? CustodyFailure)?.code, "partition-list-malformed")
    }
  }

  func testUnknownPartitionDescriptionShapeIsRefused() throws {
    let data = try PropertyListSerialization.data(
      fromPropertyList: ["Partitions": ["teamid:TEAMID1234"], "Unexpected": "value"],
      format: .xml,
      options: 0
    )
    let input = try XCTUnwrap(String(data: data, encoding: .utf8))

    XCTAssertThrowsError(try CustodyLegacyAccess.rewritePartitionDescription(
      [input], helperCDHash: helperCDHash
    )) { error in
      XCTAssertEqual((error as? CustodyFailure)?.code, "partition-list-shape")
    }
  }

  func testCurrentCDHashRewriteIsIdempotent() throws {
    let input = try plist([
      "apple-tool:",
      "cdhash:\(helperCDHash)",
      "teamid:TEAMID1234",
    ])

    let once = try CustodyLegacyAccess.rewritePartitionDescription([input], helperCDHash: helperCDHash)
    let twice = try CustodyLegacyAccess.rewritePartitionDescription([once], helperCDHash: helperCDHash)

    XCTAssertEqual(once, input)
    XCTAssertEqual(twice, once)
    XCTAssertEqual(try partitions(twice), ["apple-tool:", "cdhash:\(helperCDHash)", "teamid:TEAMID1234"])
  }
}
