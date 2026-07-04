#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <pybind11/numpy.h>
#include <cstring>
#include "matcher.h"

namespace py = pybind11;

PYBIND11_MODULE(mesh_matcher, m) {
    m.doc() = "High-performance mesh matching module for shoe mold and rough blank matching";
    
    py::class_<DirectionAlignment>(m, "DirectionAlignment")
        .def_readwrite("heel_toe_alignment", &DirectionAlignment::heel_toe_alignment)
        .def_readwrite("vertical_alignment", &DirectionAlignment::vertical_alignment)
        .def_readwrite("is_valid", &DirectionAlignment::is_valid)
        .def_readwrite("heel_toe_angle_deg", &DirectionAlignment::heel_toe_angle_deg)
        .def_readwrite("vertical_angle_deg", &DirectionAlignment::vertical_angle_deg)
        .def("__repr__", [](const DirectionAlignment& d) {
            return "DirectionAlignment(heel_toe=" + std::to_string(d.heel_toe_alignment) +
                   ", vertical=" + std::to_string(d.vertical_alignment) +
                   ", valid=" + (d.is_valid ? "True" : "False") + ")";
        });
    
    py::class_<GeneticAlgorithmParams>(m, "GeneticAlgorithmParams")
        .def(py::init<>())
        .def_readwrite("population_size", &GeneticAlgorithmParams::population_size)
        .def_readwrite("max_generations", &GeneticAlgorithmParams::max_generations)
        .def_readwrite("crossover_rate", &GeneticAlgorithmParams::crossover_rate)
        .def_readwrite("mutation_rate", &GeneticAlgorithmParams::mutation_rate)
        .def_readwrite("mutation_scale", &GeneticAlgorithmParams::mutation_scale)
        .def_readwrite("selection_rate", &GeneticAlgorithmParams::selection_rate)
        .def_readwrite("convergence_threshold", &GeneticAlgorithmParams::convergence_threshold)
        .def_readwrite("num_sample_points", &GeneticAlgorithmParams::num_sample_points)
        .def_readwrite("early_stopping_generations", &GeneticAlgorithmParams::early_stopping_generations)
        .def_readwrite("target_wrapping_ratio", &GeneticAlgorithmParams::target_wrapping_ratio)
        .def_readwrite("inside_tolerance_mm", &GeneticAlgorithmParams::inside_tolerance_mm)
        .def_readwrite("translation_range", &GeneticAlgorithmParams::translation_range)
        .def_readwrite("rotation_range", &GeneticAlgorithmParams::rotation_range)
        .def_readwrite("lateral_range", &GeneticAlgorithmParams::lateral_range)
        .def_readwrite("vertical_range", &GeneticAlgorithmParams::vertical_range)
        .def_readwrite("pitch_range", &GeneticAlgorithmParams::pitch_range)
        .def_readwrite("yaw_range", &GeneticAlgorithmParams::yaw_range);

    py::class_<GenerationState>(m, "GenerationState")
        .def(py::init<>())
        .def_readwrite("generation", &GenerationState::generation)
        .def_readwrite("best_fitness", &GenerationState::best_fitness)
        .def_readwrite("avg_fitness", &GenerationState::avg_fitness)
        .def_readwrite("std_dev", &GenerationState::std_dev)
        .def_readwrite("translation", &GenerationState::translation)
        .def_readwrite("rotation_angle_deg", &GenerationState::rotation_angle_deg)
        .def_readwrite("lateral_offset", &GenerationState::lateral_offset)
        .def_readwrite("crossover_count", &GenerationState::crossover_count)
        .def_readwrite("mutation_count", &GenerationState::mutation_count)
        .def_readwrite("time_ms", &GenerationState::time_ms);
    
    py::class_<MatchResult>(m, "MatchResult")
        .def_readwrite("candidate_index", &MatchResult::candidate_index)
        .def_readwrite("candidate_path", &MatchResult::candidate_path)
        .def_readwrite("volume", &MatchResult::volume)
        .def_readwrite("is_fully_wrapped", &MatchResult::is_fully_wrapped)
        .def_readwrite("match_score", &MatchResult::match_score)
        .def_readwrite("direction_alignment", &MatchResult::direction_alignment)
        .def_readwrite("wrapping_ratio", &MatchResult::wrapping_ratio)
        .def_readwrite("percentile96_clearance", &MatchResult::percentile96_clearance)
        .def_readwrite("optimal_translation", &MatchResult::optimal_translation)
        .def_readwrite("optimal_rotation_angle_deg", &MatchResult::optimal_rotation_angle_deg)
        .def_readwrite("optimal_vertical_offset", &MatchResult::optimal_vertical_offset)
        .def_readwrite("optimal_lateral_offset", &MatchResult::optimal_lateral_offset)
        .def_readwrite("optimal_pitch_deg", &MatchResult::optimal_pitch_deg)
        .def_readwrite("optimal_yaw_deg", &MatchResult::optimal_yaw_deg)
        .def_readwrite("meets_direction_constraints", &MatchResult::meets_direction_constraints)
        .def_readwrite("generation_history", &MatchResult::generation_history)
        .def("__repr__", [](const MatchResult& r) {
            return "MatchResult(candidate_index=" + std::to_string(r.candidate_index) +
                   ", volume=" + std::to_string(r.volume) +
                   ", wrapping_ratio=" + std::to_string(r.wrapping_ratio) +
                   ", direction_valid=" + (r.meets_direction_constraints ? "True" : "False") +
                   ", wrapped=" + (r.is_fully_wrapped ? "True" : "False") + ")";
        });
    
    py::class_<MeshMatcher>(m, "MeshMatcher")
        .def(py::init<>())
        .def("load_target_mesh", [](MeshMatcher& matcher, 
                                    py::array_t<double> vertices,
                                    py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            if (vbuf.ndim != 2 || vbuf.shape[1] != 3) {
                throw std::runtime_error("Vertices must be Nx3 array");
            }
            if (fbuf.ndim != 2 || fbuf.shape[1] != 3) {
                throw std::runtime_error("Faces must be Mx3 array");
            }
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            return matcher.loadTargetMesh(v_data, f_data);
        }, "Load target mesh (shoe mold)")
        .def("load_candidate_mesh", [](MeshMatcher& matcher,
                                       py::array_t<double> vertices,
                                       py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            if (vbuf.ndim != 2 || vbuf.shape[1] != 3) {
                throw std::runtime_error("Vertices must be Nx3 array");
            }
            if (fbuf.ndim != 2 || fbuf.shape[1] != 3) {
                throw std::runtime_error("Faces must be Mx3 array");
            }
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            return matcher.loadCandidateMesh(v_data, f_data);
        }, "Load candidate mesh (rough blank)")
        .def("set_verbose", &MeshMatcher::setVerbose,
             py::arg("verbose"),
             "Set whether to output verbose logging")
        .def("signed_distance_batch", [](MeshMatcher& matcher, py::array_t<double> points) {
            py::buffer_info buf = points.request();
            if (buf.ndim != 2 || buf.shape[1] != 3) {
                throw std::runtime_error("points must be Nx3 array");
            }
            const size_t n = static_cast<size_t>(buf.shape[0]);
            std::vector<double> pts(static_cast<double*>(buf.ptr),
                                    static_cast<double*>(buf.ptr) + n * 3);
            std::vector<double> d;
            {
                // BVH 构建 + 批量距离计算期间释放 GIL：
                // containment-refine 的上千次 batch 调用不再冻结其他 Python 线程
                py::gil_scoped_release release;
                d = matcher.computeSignedDistanceBatch(pts);
            }

            // Return as numpy array
            py::array_t<double> result(static_cast<py::ssize_t>(d.size()));
            py::buffer_info rbuf = result.request();
            std::memcpy(rbuf.ptr, d.data(), d.size() * sizeof(double));
            return result;
        },
             py::arg("points"),
             "Batch signed distance: for each Nx3 point, return d where d<0=inside, d>0=outside candidate mesh.")
        .def("match_optimized", [](MeshMatcher& matcher,
                                   double wrapping_threshold,
                                   py::object ga_params_obj,
                                   bool skip_align_directions) {
            GeneticAlgorithmParams ga_params;
            if (!ga_params_obj.is_none()) {
                try {
                    ga_params = ga_params_obj.cast<GeneticAlgorithmParams>();
                } catch (...) {
                    // 故意静默：类型不匹配时回退到默认 GA 参数（历史行为）
                }
            }

            // ga_params 已在持有 GIL 时取完；整个 C++ 匹配流水线（对齐→GA→
            // 最终指标）不触碰任何 Python 对象 → 释放 GIL，桌面端并发匹配任务
            // 与 Flask 请求处理不再被单个匹配冻结。返回值转换发生在本作用域
            // 结束（GIL 自动恢复）之后，安全。
            py::gil_scoped_release release;
            return matcher.matchOptimized(
                wrapping_threshold,
                ga_params,
                skip_align_directions
            );
        },
             py::arg("wrapping_threshold") = 1.0,
             py::arg("ga_params") = py::none(),
             py::arg("skip_align_directions") = false,
             "Perform optimized matching with automatic direction alignment and genetic algorithm optimization. "
             "Pass skip_align_directions=True if the target has been pre-aligned externally (e.g. ICP warm-start).")
        .def_static("compute_volume", [](py::array_t<double> vertices,
                                         py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            return MeshMatcher::computeVolume(v_data, f_data);
        }, "Compute mesh volume")
        .def_static("compute_principal_normal", [](py::array_t<double> vertices,
                                                   py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            Eigen::Vector3d normal = MeshMatcher::computePrincipalNormal(v_data, f_data);
            return py::make_tuple(normal.x(), normal.y(), normal.z());
        }, "Compute principal normal direction")
        .def_static("compute_longitudinal_axis", [](py::array_t<double> vertices,
                                                    py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            Eigen::Vector3d axis = MeshMatcher::computeLongitudinalAxis(v_data, f_data);
            return py::make_tuple(axis.x(), axis.y(), axis.z());
        }, "Compute longitudinal axis")
        .def_static("compute_vertical_axis", [](py::array_t<double> vertices,
                                                py::array_t<int> faces) {
            py::buffer_info vbuf = vertices.request();
            py::buffer_info fbuf = faces.request();
            
            std::vector<double> v_data(static_cast<double*>(vbuf.ptr),
                                      static_cast<double*>(vbuf.ptr) + vbuf.size);
            std::vector<int> f_data(static_cast<int*>(fbuf.ptr),
                                    static_cast<int*>(fbuf.ptr) + fbuf.size);
            
            Eigen::Vector3d axis = MeshMatcher::computeVerticalAxis(v_data, f_data);
            return py::make_tuple(axis.x(), axis.y(), axis.z());
        }, "Compute vertical axis");
}
