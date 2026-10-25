import Foundation
import SwiftUI

// No vendor login credentials belong in either iPhone app. All purchasing is reviewed server-side.
enum APIError: LocalizedError {
    case invalidURL, notSignedIn, request(String)
    var errorDescription: String? {
        switch self {
        case .invalidURL: "Set an HTTPS server address in Settings"
        case .notSignedIn: "Sign in to Owner Tracker"
        case .request(let value): value
        }
    }
}

struct EmptyData: Codable {}

@MainActor final class OwnerAPI: ObservableObject {
    @AppStorage("serverUrl") var serverUrl = ""
    @Published var signedIn = false
    @Published var userName = ""
    @Published var errorMessage = ""

    func call(_ path: String, method: String = "GET", body: [String: Any]? = nil, expectedRevision: Int? = nil) async throws -> [String: Any] {
        let raw = serverUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard raw.hasPrefix("https://"), let base = URL(string:raw), let url = URL(string:path, relativeTo:base) else {throw APIError.invalidURL}
        var request = URLRequest(url:url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField:"Content-Type")
        request.timeoutInterval = 25
        var payload = body
        if let target = editRevisionTarget(path, method:method, body:body ?? [:]) {
            let revision = expectedRevision ?? (body?["expectedRevision"] as? NSNumber)?.intValue
            guard let revision, revision > 0 else {
                throw APIError.request("Reload this record before editing. Its original version is required.")
            }
            request.setValue("\"\(target.table):\(target.id):\(revision)\"", forHTTPHeaderField:"If-Match")
            payload = body ?? [:]
            payload?["expectedRevision"] = revision
        }
        if let payload { request.httpBody = try JSONSerialization.data(withJSONObject:payload) }
        let (data,response) = try await URLSession.shared.data(for:request)
        guard let http = response as? HTTPURLResponse else {throw APIError.request("Server unavailable")}
        let value = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:]
        if http.statusCode == 409, value["currentRevision"] != nil {
            throw APIError.request("Another employee changed this record. Your changes were not saved. Refresh it and review your edits before saving again.")
        }
        guard (200...299).contains(http.statusCode) else {throw APIError.request(value["error"] as? String ?? "Server error \(http.statusCode)")}
        return value
    }
    // The revision comes from the record already displayed by the editor. Never
    // fetch a fresh record during save, which would conceal a stale overwrite.
    func updateWorkOrder(_ id:Int, changes:[String:Any], original:[String:Any]) async throws -> [String:Any] {
        try await call("/api/work-orders/\(id)", method:"PATCH", body:changes, expectedRevision:original.int("revision"))
    }
    private func editRevisionTarget(_ path:String, method:String, body:[String:Any]) -> (table:String,id:Int)? {
        let components = path.split(separator:"/").map(String.init)
        let patterns:[(String,String)]
        if ["PATCH","DELETE"].contains(method.uppercased()) {
            patterns = [("^/api/pos/customers/(\\d+)$","customers"),("^/api/pos/vehicles/(\\d+)$","vehicles"),("^/api/(?:pos/)?work-orders/(\\d+)$","work_orders"),("^/api/pos/lines/(\\d+)$","work_order_lines"),("^/api/shop/retail-orders/(\\d+)$","retail_special_orders"),("^/api/shop/retail-orders/\\d+/lines/(\\d+)$","retail_special_lines")]
        } else if method.uppercased() == "POST" {
            var actions = [("^/api/pos/work-orders/(\\d+)/lines$","work_orders"),("^/api/work-orders/(\\d+)/(?:ready|request-approval)$","work_orders"),("^/api/shop/retail-orders/(\\d+)/(?:lines|issue-invoice)$","retail_special_orders"),("^/api/shop/retail-orders/\\d+/lines/(\\d+)/(?:verify|status)$","retail_special_lines")]
            if body["stage"] != nil { actions.append(("^/api/work-orders/(\\d+)/updates$","work_orders")) }
            patterns = actions
        } else { return nil }
        guard components.first == "api" else {return nil}
        let range = NSRange(path.startIndex..<path.endIndex,in:path)
        for (pattern,table) in patterns {
            guard let regex = try? NSRegularExpression(pattern:pattern),let match = regex.firstMatch(in:path,range:range),let idRange = Range(match.range(at:1),in:path),let id = Int(path[idRange]) else {continue}
            return (table,id)
        }
        return nil
    }
    func login(username:String,password:String) async {
        do {
            _ = try await call("/api/login", method:"POST", body:["username":username,"password":password])
            let result = try await call("/api/me")
            let user = result["user"] as? [String:Any] ?? [:]
            userName = user["displayName"] as? String ?? username
            signedIn = true
            errorMessage = ""
        } catch {errorMessage=error.localizedDescription}
    }
    func logout() async { _ = try? await call("/api/logout",method:"POST",body:[:]);signedIn=false }
    func checkSession() async {
        guard !serverUrl.isEmpty else {return}
        do {let value=try await call("/api/me");let user=value["user"] as? [String:Any]; signedIn=(user != nil);userName=user?["displayName"] as? String ?? ""}catch{signedIn=false}
    }
}

struct LoginView: View {
    @ObservedObject var api: OwnerAPI
    @State private var username = ""
    @State private var password = ""
    @State private var pending = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Connect to the shop") {
                    TextField("https://your-server.example.com",text:$api.serverUrl).textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                    Text("HTTPS is required. Set up a secure domain/reverse proxy before connecting remotely.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Employee sign-in") {
                    TextField("Username",text:$username).textInputAutocapitalization(.never)
                    SecureField("Password or PIN",text:$password)
                    Button("Sign In") {pending=true;Task{await api.login(username:username,password:password);pending=false}}.disabled(pending)
                }
                if !api.errorMessage.isEmpty {Text(api.errorMessage).foregroundStyle(.red)}
            }.navigationTitle("Owner Tracker")
        }
    }
}

extension Dictionary where Key == String, Value == Any {
    func str(_ key:String) -> String { String(describing:self[key] ?? "") }
    func double(_ key:String) -> Double { (self[key] as? NSNumber)?.doubleValue ?? 0 }
    func int(_ key:String) -> Int { (self[key] as? NSNumber)?.intValue ?? 0 }
    func array(_ key:String) -> [[String:Any]] {self[key] as? [[String:Any]] ?? []}
}
