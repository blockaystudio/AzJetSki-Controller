const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// PWC is the existing database value; staff see its full name in forms.
export const vehicleCategories = [
  ['PWC', 'Personal watercraft'],
  ['Jet boat', 'Jet boat'],
  ['Boat', 'Boat'],
  ['ATV', 'ATV'],
  ['UTV', 'UTV'],
  ['Motorcycle', 'Motorcycle'],
  ['Other', 'Other']
];

export function vehicleCategoryField(value = 'PWC') {
  const selected = String(value || 'PWC');
  const options = vehicleCategories.some(([category]) => category === selected)
    ? vehicleCategories : [...vehicleCategories, [selected, selected]];
  return `<label class="field"><span>Type / category</span><select name="category" required>${options.map(([category, label]) => `<option value="${esc(category)}"${category === selected ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
}
