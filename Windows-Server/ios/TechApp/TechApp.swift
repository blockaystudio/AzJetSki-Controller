import SwiftUI
import PhotosUI
import UIKit

@main struct OwnerTrackerTechApp:App {
    @StateObject private var api=OwnerAPI()
    var body:some Scene {WindowGroup {Group {if api.signedIn {TechnicianWork(api:api)} else {LoginView(api:api)}}.task{await api.checkSession()}}}
}
struct TechnicianWork:View {
    @ObservedObject var api:OwnerAPI
    @State private var jobs:[[String:Any]]=[]
    @State private var message=""
    var body:some View {NavigationStack {List {
        ForEach(Array(jobs.enumerated()),id:\.offset){pair in
            let w = pair.element
            NavigationLink {TechWorkOrder(api:api,id:w.int("id"))} label:{VStack(alignment:.leading,spacing:5){Text("WO " + w.str("ref_number") + " · " + w.str("stage")).font(.headline);Text(w.str("unit_label"));Text(w.str("next_action")).font(.caption).foregroundStyle(.secondary)}}}
        if jobs.isEmpty{ContentUnavailableView("No assigned jobs",systemImage:"wrench.and.screwdriver")}
        if !message.isEmpty{Text(message)}
    }.navigationTitle("My Work").toolbar{Button("Sign Out"){Task{await api.logout()}}}.task{await refresh()}.refreshable{await refresh()}}}
    func refresh() async {do{jobs=try await api.call("/api/my-work").array("workOrders")}catch{message=error.localizedDescription}}
}
struct TechWorkOrder:View {
    @ObservedObject var api:OwnerAPI
    let id:Int
    @State private var work:[String:Any]=[:]
    @State private var note=""
    @State private var partName=""
    @State private var partNumber=""
    @State private var partNote=""
    @State private var qty="1"
    @State private var updateTitle=""
    @State private var updateNote=""
    @State private var photoCaption=""
    @State private var visible=true
    @State private var notify=false
    @State private var images:[PhotosPickerItem]=[]
    @State private var currentTab=0
    @State private var message=""
    var body:some View {Form {
        Section("Job") {Text(work.str("unit_label")).font(.headline);Text(work.str("customer_name"));Text(work.str("complaint"));Text(work.str("stage")).foregroundStyle(.secondary)}
        Picker("Activity",selection:$currentTab){Text("Photos & Updates").tag(0);Text("Private Notes").tag(1);Text("Parts Needed").tag(2)}.pickerStyle(.segmented)
        if currentTab==0 {
            Section("Customer-facing update") {
                TextField("Update title",text:$updateTitle)
                TextField("Progress explanation",text:$updateNote,axis:.vertical).lineLimit(3...8)
                TextField("Photo caption",text:$photoCaption)
                PhotosPicker(selection:$images,maxSelectionCount:6,matching:.images) {Label("Select photos",systemImage:"camera.fill")}
                Text("\(images.count) photo(s) selected").font(.caption)
                Toggle("Visible to customer",isOn:$visible)
                Toggle("Request customer notification",isOn:$notify)
                Button("Post update with photos"){Task{await sendUpdate()}}.disabled(updateTitle.isEmpty && updateNote.isEmpty)
            }
        } else if currentTab==1 {
            Section("Internal diagnostic notes") {
                Text("Private notes are never shown to customers.").font(.caption)
                TextField("Measurements, fault codes, findings…",text:$note,axis:.vertical).lineLimit(4...10)
                Button("Save Private Note"){Task{await saveNote()}}.disabled(note.isEmpty)
                ForEach(Array(work.array("notes").enumerated()),id:\.offset){pair in
                    let n = pair.element
            VStack(alignment:.leading){Text(n.str("body"));Text(n.str("author")).font(.caption).foregroundStyle(.secondary)}}
            }
        } else {
            Section("Request part — not a sale or purchase") {
                TextField("Part number (optional)",text:$partNumber)
                TextField("Description",text:$partName)
                TextField("Quantity",text:$qty).keyboardType(.numberPad)
                TextField("Parts department note",text:$partNote,axis:.vertical)
                Button("Send Part Request"){Task{await requestPart()}}.disabled(partName.isEmpty)
            }
            Section("Part requests") {ForEach(Array(work.array("parts").enumerated()),id:\.offset){pair in
                let p = pair.element
            Text(p.str("description") + " ×" + p.str("qty_needed") + " · " + p.str("status"))}}
        }
        if !message.isEmpty{Section {Text(message).foregroundStyle(.secondary)}}
    }.navigationTitle("WO #" + String(id)).task{await refresh()}}
    func refresh() async{do{work=(try await api.call("/api/work-orders/\(id)"))["workOrder"] as? [String:Any] ?? [:]}catch{message=error.localizedDescription}}
    func saveNote() async {do{_ = try await api.call("/api/work-orders/\(id)/notes",method:"POST",body:["body":note]);note="";message="Internal note saved";await refresh()}catch{message=error.localizedDescription}}
    func requestPart() async {do{_ = try await api.call("/api/work-orders/\(id)/parts",method:"POST",body:["item_ref":partNumber,"description":partName,"qty_needed":Int(qty) ?? 1,"notes":partNote]);partName="";partNote="";message="Part request sent";await refresh()}catch{message=error.localizedDescription}}
    func sendUpdate() async {
        do {
            var mediaIDs:[Int]=[]
            for item in images {
                guard let bytes=try await item.loadTransferable(type:Data.self),let image=UIImage(data:bytes),let jpeg=image.jpegData(compressionQuality:0.78) else {continue}
                let result=try await api.call("/api/work-orders/\(id)/media",method:"POST",body:["filename":"inspection.jpg","mimeType":"image/jpeg","dataBase64":jpeg.base64EncodedString(),"scope":"progress","caption":photoCaption,"customerVisible":visible])
                mediaIDs.append(result.int("mediaId"))
            }
            _ = try await api.call("/api/work-orders/\(id)/updates",method:"POST",body:["title":updateTitle,"body":updateNote,"mediaIds":mediaIDs,"customerVisible":visible,"notifyCustomer":notify])
            message="Update saved with \(mediaIDs.count) photo(s)";updateTitle="";updateNote="";images=[];await refresh()
        } catch {message=error.localizedDescription}
    }
}
