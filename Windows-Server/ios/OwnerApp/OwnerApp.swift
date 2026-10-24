import SwiftUI

@main struct OwnerTrackerOwnerApp: App {
    @StateObject private var api = OwnerAPI()
    var body: some Scene {
        WindowGroup {
            Group { if api.signedIn { OwnerHome(api:api) } else { LoginView(api:api) } }
                .task {await api.checkSession()}
        }
    }
}

struct OwnerHome: View {
    @ObservedObject var api:OwnerAPI
    @State private var tab = 0
    var body: some View {
        TabView(selection:$tab) {
            OwnerDashboard(api:api).tabItem {Label("Overview",systemImage:"chart.bar.fill")}.tag(0)
            OwnerParts(api:api).tabItem {Label("Supplier Carts",systemImage:"cart.fill")}.tag(1)
            OwnerJobs(api:api).tabItem {Label("Jobs",systemImage:"wrench.and.screwdriver")}.tag(2)
            Form {Button("Sign Out"){Task{await api.logout()}}}.tabItem {Label("Account",systemImage:"person")}.tag(3)
        }
    }
}

struct OwnerDashboard:View {
    @ObservedObject var api:OwnerAPI
    @State private var values:[String:Any] = [:]
    @State private var error = ""
    var body:some View {
        NavigationStack { List {
            if let summary=values["summary"] as? [String:Any] {
                Section("Shop snapshot") {
                    LabeledContent("Open jobs",value:summary.str("open_jobs"))
                    LabeledContent("Pipeline",value:summary.double("pipeline").formatted(.currency(code:"USD")))
                    LabeledContent("Awaiting approval",value:summary.str("approvals"))
                    LabeledContent("Parts missing",value:summary.str("parts_missing"))
                    LabeledContent("Unpaid",value:summary.double("unpaid").formatted(.currency(code:"USD")))
                }
            }
            Section("Recent work") {
                ForEach(Array((values["recent"] as? [[String:Any]] ?? []).enumerated()),id:\.offset) { pair in
                    let w = pair.element
                    VStack(alignment:.leading) {Text("WO " + w.str("ref_number")).font(.headline);Text(w.str("customer_name") + " · " + w.str("unit_label"));Text(w.str("stage")).font(.caption).foregroundStyle(.secondary)}
                }
            }
            if !error.isEmpty {Text(error).foregroundStyle(.red)}
        }.navigationTitle("Owner Control").toolbar{Button("Refresh"){Task{await load()}}}.task{await load()} }
    }
    func load() async {do{values=try await api.call("/api/dashboard")}catch{self.error=error.localizedDescription}}
}

struct OwnerJobs:View {
    @ObservedObject var api:OwnerAPI
    @State private var jobs:[[String:Any]]=[]
    var body:some View {NavigationStack {List(Array(jobs.enumerated()),id:\.offset) { pair in
        let w = pair.element
        VStack(alignment:.leading) {Text("WO " + w.str("ref_number") + " · " + w.str("stage")).font(.headline);Text(w.str("customer_name"));Text(w.str("unit_label")).font(.caption)}
    }.navigationTitle("Work Orders").task{jobs=(try? await api.call("/api/work-orders").array("workOrders")) ?? []}.refreshable{jobs=(try? await api.call("/api/work-orders").array("workOrders")) ?? []}}}
}

struct OwnerParts: View {
    @ObservedObject var api:OwnerAPI
    @State private var vendors:[[String:Any]]=[]
    @State private var carts:[[String:Any]]=[]
    @State private var missing:[[String:Any]]=[]
    @State private var info=""
    @State private var selectedCart:[String:Any]?
    var body:some View {NavigationStack {List {
        Section {Text("Review each SKU, fitment, quantity, cost, and stock before queuing. Threshold eligibility never means automatic purchasing.").font(.caption)}
        Section("Supplier thresholds") {ForEach(Array(vendors.enumerated()),id:\.offset){pair in
            let v = pair.element
            LabeledContent(v.str("name"),value:v.double("order_threshold").formatted(.currency(code:"USD")))} }
        Section("Carts") {ForEach(Array(carts.enumerated()),id:\.offset){pair in
            let cart = pair.element
            Button {selectedCart=cart} label: {VStack(alignment:.leading) {Text(cart.str("vendor_name") + " — #" + cart.str("id"));Text(cart.double("total").formatted(.currency(code:"USD")) + " · " + cart.str("status")).font(.caption)}}
        }}
        Section("Unmatched parts (\(missing.count))") {ForEach(Array(missing.enumerated()),id:\.offset){pair in
            let p = pair.element
            Text(p.str("description") + " (WO " + p.str("ref_number") + ")")}}
        if !info.isEmpty{Text(info).font(.caption)}
    }.navigationTitle("Supplier Carts").toolbar{Button("Refresh"){Task{await load()}}}.task{await load()}.sheet(item:Binding<ReviewSelection?>(get:{selectedCart.map{ReviewSelection(cart:$0)}},set:{selectedCart=$0?.cart})){selection in CartReview(api:api,cart:selection.cart,onSuccess:{info=$0;selectedCart=nil;Task{await load()}})} }
    }
    func load() async {do{let d=try await api.call("/api/procurement");vendors=d.array("vendors");carts=d.array("carts");missing=d.array("missing")}catch{info=error.localizedDescription}}
}
struct ReviewSelection:Identifiable {let cart:[String:Any];var id:Int {cart.int("id")}}

struct CartReview:View {
    @ObservedObject var api:OwnerAPI
    let cart:[String:Any]
    let onSuccess:(String)->Void
    @State private var accepted:Set<Int>=[]
    @State private var confirm=""
    @State private var info=""
    var lines:[[String:Any]]{cart.array("lines")}
    var body:some View {NavigationStack{Form {
        Section {Text("Each check confirms you compared the actual dealer listing, correct fitment, stock and price. No purchase is performed until a tested supplier connector exists.").font(.caption)}
        Section("Vendor: " + cart.str("vendor_name")) {ForEach(Array(lines.enumerated()),id:\.offset){pair in
            let l = pair.element
            Toggle(isOn:Binding(get:{accepted.contains(l.int("id"))},set:{if $0{accepted.insert(l.int("id"))}else{accepted.remove(l.int("id"))}})) {
                VStack(alignment:.leading){Text(l.str("vendor_sku")).font(.headline);Text(l.str("description"));Text("Qty \(l.str("qty")) × $\(l.str("unit_cost")) · stock \(l.str("available_qty"))").font(.caption)}
            }
        }}
        Section("Confirm") {TextField("Type ORDER " + cart.str("vendor_code"),text:$confirm).textInputAutocapitalization(.characters);Button("Queue Reviewed Cart on Desktop"){Task{await queue()}}.disabled(accepted.count != lines.count || confirm != "ORDER " + cart.str("vendor_code"))}
        if !info.isEmpty{Text(info)}
    }.navigationTitle("Review Cart #" + cart.str("id"))}}
    func queue() async {
        let checked=lines.map{l -> [String:Any] in ["id":l.int("id"),"confirmed":accepted.contains(l.int("id")),"vendor_sku":l.str("vendor_sku"),"qty":l.double("qty"),"unit_cost":l.double("unit_cost")]}
        do {let r=try await api.call("/api/procurement/carts/\(cart.int("id"))/review",method:"POST",body:["confirmText":confirm,"lines":checked]);onSuccess("Queued command: " + r.str("commandId") + ". Not yet purchased.")}
        catch{info=error.localizedDescription}
    }
}
